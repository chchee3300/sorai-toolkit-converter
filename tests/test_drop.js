// Automated test for file drag-and-drop (both modes), run with: node tests/test_drop.js (from the project root)
// - Test B: browser-mode fallback (DOM drop + DataTransfer -> chunked temp copy)
// - Test A: window-mode path (simulated native filesDropped event payloads)
// - Test C: negative cases (empty drop, bad payloads)
// Exits 0 on success, 1 on any failure.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
const { chromium } = require('playwright');
const { spawnNeu, killNeuTree } = require('./lib/neu-launch');

// neu run must launch from the project root (neutralino.config.json,
// binaries/, .tmp/ all live there); fixtures live alongside this script.
const PROJECT_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const FIXTURE = path.join(FIXTURES_DIR, 'test_in.png');
const VIDEO_FIXTURE = path.join(FIXTURES_DIR, 'test_fixture_video.mp4');
const DROP_TEMP = path.join(os.tmpdir(), 'FileConverterApp', 'dropped');

const results = [];
function check(name, cond, extra) {
    results.push({ name, ok: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && extra !== undefined ? '  -> ' + extra : ''}`);
}

function waitForAuthInfo(sinceMs, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        (function poll() {
            try {
                const st = fs.statSync(path.join(PROJECT_ROOT, '.tmp', 'auth_info.json'));
                if (st.mtimeMs > sinceMs) return resolve();
            } catch (e) { /* not written yet */ }
            if (Date.now() - t0 > timeoutMs) return reject(new Error('auth_info.json not refreshed within ' + timeoutMs + 'ms'));
            setTimeout(poll, 500);
        })();
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function clearFileList(page) {
    if (await page.$('#file-list .file-item')) {
        await page.click('#btn-clear-files');
        await page.waitForFunction(() => document.querySelectorAll('#file-list .file-item').length === 0);
    }
}

async function main() {
    // Watchdog: never hang CI
    setTimeout(() => { console.error('WATCHDOG: test exceeded 120s, aborting'); process.exit(1); }, 120000);

    if (!fs.existsSync(FIXTURE)) {
        console.error('Fixture missing: ' + FIXTURE);
        process.exit(1);
    }
    if (!fs.existsSync(VIDEO_FIXTURE)) {
        console.error('Fixture missing: ' + VIDEO_FIXTURE);
        process.exit(1);
    }
    const fixtureBytes = fs.readFileSync(FIXTURE);

    const launchTime = Date.now();
    const neu = spawnNeu(PROJECT_ROOT);
    neu.stdout.on('data', d => process.stdout.write('[neu] ' + d));
    neu.stderr.on('data', d => process.stderr.write('[neu:err] ' + d));
    let browser = null;
    let dialogCount = 0;
    const pageErrors = [];

    try {
        await waitForAuthInfo(launchTime);
        const auth = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, '.tmp', 'auth_info.json'), 'utf8'));
        const url = 'http://localhost:' + auth.nlPort + '/?nlToken=' + auth.nlToken;
        console.log('Connecting to', url);

        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('pageerror', err => { pageErrors.push(err.message); console.log('PAGE ERROR:', err.message); });
        page.on('dialog', d => { dialogCount++; console.log('PAGE DIALOG:', d.message()); d.dismiss().catch(() => {}); });

        // The one-time token is consumed by the system browser that `neu run`
        // auto-opens; the client library falls back to sessionStorage.NL_TOKEN,
        // so seed it there before any page script runs.
        await page.addInitScript(t => { try { sessionStorage.setItem('NL_TOKEN', t); } catch (e) {} }, auth.nlToken);
        await page.goto(url);
        await page.waitForSelector('#input-panel');
        // React build has no window.importDroppedFiles global (it's an
        // internal hook callback now) — wait on NL_MODE + Neutralino
        // instead, both still genuine Neutralino-injected globals.
        await page.waitForFunction(() => typeof window.NL_MODE !== 'undefined' && typeof window.Neutralino !== 'undefined');

        // ---------- Test B: browser-mode fallback (must run first: outputPath
        // is a closure `let`; Test A would set it to the fixture's dir and mask
        // the Downloads-default assertion) ----------
        console.log('\n--- Test B: browser-mode DOM drop fallback ---');
        const fixtureName = `drop_fixture_${Date.now()}.png`;
        await page.evaluate(async ({ b64, name }) => {
            // neutralino.config.json's defaultMode is 'window' (the real
            // app always runs that way now), which makes useFileManager
            // .js's onDrop bail out before reading dataTransfer (real
            // native drops arrive via the 'filesDropped' event instead,
            // exercised by Test A below). This test specifically targets
            // the browser-mode DOM-drop fallback path, so force NL_MODE at
            // the moment of the drop -- by now the app has already
            // finished reading the real value during its own init, so this
            // plain overwrite isn't itself clobbered by anything later.
            window.NL_MODE = 'browser';
            window.__DROP_CHUNK_SIZE = 16384; // force multi-chunk write for the fixture
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], name, { type: 'image/png' }));
            document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        }, { b64: fixtureBytes.toString('base64'), name: fixtureName });

        await page.waitForSelector('#file-list .file-item', { timeout: 20000 });
        const itemTextB = await page.$eval('#file-list .file-item', el => el.innerText);
        check('B1: dropped file appears in list', itemTextB.includes(fixtureName), itemTextB);
        const expectedMB = (fixtureBytes.length / (1024 * 1024)).toFixed(1);
        check('B2: listed size matches', itemTextB.includes(`${expectedMB} MB`), itemTextB);
        const containerVisible = await page.$eval('#file-list-container', el => !el.classList.contains('hidden'));
        check('B3: file list container visible', containerVisible);

        // temp copy exists on disk and is byte-identical (proves chunked append)
        let tempCopy = null;
        if (fs.existsSync(DROP_TEMP)) {
            for (const sub of fs.readdirSync(DROP_TEMP)) {
                const cand = path.join(DROP_TEMP, sub, fixtureName);
                if (fs.existsSync(cand)) { tempCopy = cand; break; }
            }
        }
        check('B4: temp copy created', tempCopy !== null, DROP_TEMP);
        if (tempCopy) {
            check('B5: temp copy byte-identical to source', fs.readFileSync(tempCopy).equals(fixtureBytes));
        }

        const outPathVal = await page.$eval('#output-path', el => el.value);
        check('B6: output path defaulted (non-empty)', outPathVal.length > 0, outPathVal);
        check('B7: output path is not the temp dir', !outPathVal.toLowerCase().startsWith(os.tmpdir().toLowerCase()), outPathVal);

        await clearFileList(page);

        // ---------- Test A: window-mode path via simulated filesDropped ----------
        console.log('\n--- Test A: filesDropped event payload shapes ---');
        const absPath = FIXTURE;
        const statSize = (fs.statSync(FIXTURE).size / (1024 * 1024)).toFixed(1);
        const shapes = [
            { label: 'array of strings (canonical 6.8.0)', payload: [absPath] },
            { label: 'plain string', payload: absPath },
            { label: 'array of {path} objects', payload: [{ path: absPath }] },
        ];
        for (const shape of shapes) {
            await page.evaluate(p => Neutralino.events.dispatch('filesDropped', p), shape.payload);
            await page.waitForSelector('#file-list .file-item', { timeout: 20000 });
            const title = await page.$eval('#file-list .file-item span[title]', el => el.getAttribute('title'));
            const text = await page.$eval('#file-list .file-item', el => el.innerText);
            check(`A: ${shape.label} — real path kept`, title === absPath, title);
            check(`A: ${shape.label} — name & size rendered`, text.includes('test_in.png') && text.includes(`${statSize} MB`), text);
            await clearFileList(page);
        }

        // ---------- Test C: negative cases ----------
        console.log('\n--- Test C: negative cases ---');
        await page.evaluate(() => {
            const dt = new DataTransfer();
            document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        });
        await page.evaluate(() => Neutralino.events.dispatch('filesDropped', []));
        await page.evaluate(() => Neutralino.events.dispatch('filesDropped', { foo: 1 }));
        await sleep(1500);
        const itemCount = await page.$$eval('#file-list .file-item', els => els.length);
        check('C1: no items added by empty/bad drops', itemCount === 0, itemCount);
        const overlayHidden = await page.$eval('#file-loading-overlay', el => el.classList.contains('hidden'));
        check('C2: loading overlay not stuck', overlayHidden);
        check('C3: page still responsive', (await page.evaluate(() => 1)) === 1);

        // ---------- Test D: mixed-file-type confirm modal ----------
        console.log('\n--- Test D: mixed-file-type confirm modal ---');
        await page.evaluate(p => Neutralino.events.dispatch('filesDropped', [p]), FIXTURE);
        await page.waitForSelector('#file-list .file-item', { timeout: 20000 });

        // Dropping a different-type file while one is loaded must NOT add it
        // directly — it should park behind a confirm modal instead.
        await page.evaluate(p => Neutralino.events.dispatch('filesDropped', [p]), VIDEO_FIXTURE);
        await page.waitForSelector('#mixed-type-modal:not(.hidden)', { timeout: 5000 });
        const itemCountD1 = await page.$$eval('#file-list .file-item', els => els.length);
        check('D1: mismatched drop does not add the file directly', itemCountD1 === 1, itemCountD1);
        const modalText = await page.$eval('#mixed-type-modal .modal-body', el => el.innerText);
        check('D2: modal wording mentions both file types', modalText.includes('video') && modalText.includes('image'), modalText);

        // "Keep current files" leaves the existing batch untouched.
        await page.click('#btn-mixed-type-cancel');
        await page.waitForFunction(() => document.getElementById('mixed-type-modal').classList.contains('hidden'), { timeout: 5000 });
        const typeBadgeD1 = await page.$eval('#type-badge', el => el.textContent);
        const itemCountD2 = await page.$$eval('#file-list .file-item', els => els.length);
        check('D3: declining keeps the original file/type untouched', typeBadgeD1 === 'Image' && itemCountD2 === 1, typeBadgeD1 + ' / ' + itemCountD2);

        // "Clear & load" swaps the batch to the new type.
        await page.evaluate(p => Neutralino.events.dispatch('filesDropped', [p]), VIDEO_FIXTURE);
        await page.waitForSelector('#mixed-type-modal:not(.hidden)', { timeout: 5000 });
        await page.click('#btn-mixed-type-confirm');
        await page.waitForFunction(() => document.getElementById('mixed-type-modal').classList.contains('hidden'), { timeout: 5000 });
        // loadFiles' getMediaInfo probe is a real ffmpeg.exe subprocess call.
        await page.waitForFunction(() => document.getElementById('type-badge').textContent === 'Video', { timeout: 15000 });
        const itemsD3 = await page.$$eval('#file-list .file-item', els => els.map(el => el.innerText));
        check('D4: confirming clears the old batch and loads the new type', itemsD3.length === 1 && itemsD3[0].includes('test_fixture_video.mp4'), itemsD3);

        await clearFileList(page);

        // ---------- Global invariants ----------
        check('G1: no alert/confirm dialogs during drop flows', dialogCount === 0, dialogCount);
        check('G2: no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    } catch (e) {
        console.error('TEST HARNESS ERROR:', e);
        results.push({ name: 'harness completed', ok: false });
    } finally {
        if (browser) await browser.close().catch(() => {});
        killNeuTree(neu.pid);
        try { fs.rmSync(DROP_TEMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
    if (failed.length) failed.forEach(f => console.log('FAILED:', f.name));
    process.exit(failed.length ? 1 : 0);
}

main();
