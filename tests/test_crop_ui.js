// End-to-end coverage for the Photo Crop feature's interactive UI (drag
// rectangle, aspect-ratio presets, Clear/Save) and the Photo Resize UX fix
// (per-file resolution preview in FileList.jsx, no longer last-file-only).
// Reuses test_drop.js's neu-launch/auth/teardown pattern (see
// [[neu-playwright-test-pattern]]). Drives the REAL app UI end-to-end,
// including a real ffmpeg crop+scale execution, per CLAUDE.md's mandatory
// regression policy for image conversion changes.
// Run with: node tests/test_crop_ui.js (from the project root)
// Exits 0 on success, 1 on any failure.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { chromium } = require('playwright');
const { execFileSync } = cp;

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

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
function rmIfExists(p) { try { fs.unlinkSync(p); } catch (e) { /* fine */ } }

async function dropFile(page, absPath) {
    await page.evaluate(p => Neutralino.events.dispatch('filesDropped', [p]), absPath);
    await page.waitForSelector('#file-list .file-item', { timeout: 20000 });
}

async function setRangeValue(page, selector, value) {
    await page.evaluate(({ selector, value }) => {
        const el = document.querySelector(selector);
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { selector, value });
}

async function runExecuteAndWait(page, timeoutMs = 60000) {
    await page.click('#btn-execute');
    await page.waitForFunction(() => /^(Completed|Cancelled)/.test(document.getElementById('progress-text').innerText), { timeout: timeoutMs });
    return page.$eval('#progress-text', el => el.innerText);
}

async function main() {
    setTimeout(() => { console.error('WATCHDOG: test exceeded 180s, aborting'); process.exit(1); }, 180000);

    const cleanupNames = ['test_in_converted.jpg'];
    cleanupNames.forEach(n => rmIfExists(path.join(FIXTURES_DIR, n)));

    const imageFixture = path.join(FIXTURES_DIR, 'test_in.png'); // 320x240, per test_conversion.js's ICO comment
    if (!fs.existsSync(imageFixture)) { console.error('Fixture missing: ' + imageFixture); process.exit(1); }

    const env = { ...process.env, PATH: process.env.PATH + ';' + path.join(process.env.APPDATA || '', 'npm') };
    const launchTime = Date.now();
    const neu = cp.spawn('cmd.exe', ['/c', 'neu run -- --export-auth-info'], { stdio: 'pipe', cwd: PROJECT_ROOT, env });
    neu.stdout.on('data', d => process.stdout.write('[neu] ' + d));
    neu.stderr.on('data', d => process.stderr.write('[neu:err] ' + d));
    let browser = null;
    const pageErrors = [];

    try {
        await waitForAuthInfo(launchTime);
        const auth = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, '.tmp', 'auth_info.json'), 'utf8'));
        const url = 'http://localhost:' + auth.nlPort + '/?nlToken=' + auth.nlToken;
        console.log('Connecting to', url);

        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.on('pageerror', err => { pageErrors.push(err.message); console.log('PAGE ERROR:', err.message); });
        page.on('dialog', d => { console.log('PAGE DIALOG:', d.message()); d.dismiss().catch(() => {}); });
        await page.addInitScript(t => { try { sessionStorage.setItem('NL_TOKEN', t); } catch (e) {} }, auth.nlToken);
        await page.goto(url);
        await page.waitForSelector('#input-panel');
        await page.waitForFunction(() => typeof window.NL_MODE !== 'undefined' && typeof window.Neutralino !== 'undefined');

        console.log('\n--- CROP UI ---');
        await dropFile(page, imageFixture);
        check('C0: crop button visible for image files', await page.isVisible('#btn-crop-0'));

        // ---------- Resize UX: per-file resolution preview (bug fix) ----------
        await setRangeValue(page, '#image-scale', '50');
        const res0 = await page.$eval('#file-resolution-0', el => el.innerText);
        check('C1: per-file resolution preview reflects Scale % before any crop', res0.includes('160 x 120'), res0);

        // ---------- Open the crop modal ----------
        await page.click('#btn-crop-0');
        await page.waitForSelector('#crop-modal:not(.hidden)');
        // Full-frame default (matches the source's own 320x240)
        const dimsBefore = await page.$eval('#crop-dims-label', el => el.innerText);
        check('C2: crop modal opens with the full frame selected by default', dimsBefore.includes('320') && dimsBefore.includes('240'), dimsBefore);

        // ---------- Aspect ratio preset: 1:1 recenters a square rect ----------
        await page.click('#crop-ratio-1\\:1');
        const dims1x1 = await page.$eval('#crop-dims-label', el => el.innerText);
        const m1x1 = /(\d+)\s*x\s*(\d+)/.exec(dims1x1);
        check('C3: 1:1 preset produces a square crop rect', !!m1x1 && m1x1[1] === m1x1[2], dims1x1);

        // ---------- Free-drag the SE handle inward ----------
        // "Clear Crop" (not the Free preset button, which only unlocks the
        // ratio without touching the rect) resets to the full frame so the
        // SE handle is at the container's true bottom-right corner, matching
        // this test's coordinate math below.
        await page.click('#crop-modal .btn-ghost');
        const containerBox = await page.$eval('#crop-container', el => {
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width, height: r.height };
        });
        // Drag the SE (bottom-right) handle from the image's natural
        // bottom-right corner to its natural center (320x240 -> ~160x120),
        // in displayed-pixel space (containerBox scales 1:1 with the
        // rendered image, which is what beginDrag/getNaturalPoint read).
        const startX = containerBox.left + containerBox.width - 1;
        const startY = containerBox.top + containerBox.height - 1;
        const endX = containerBox.left + containerBox.width / 2;
        const endY = containerBox.top + containerBox.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(endX, endY, { steps: 10 });
        await page.mouse.up();

        const dimsAfterDrag = await page.$eval('#crop-dims-label', el => el.innerText);
        const mDrag = /(\d+)\s*x\s*(\d+)/.exec(dimsAfterDrag);
        const draggedW = mDrag ? Number(mDrag[1]) : 0;
        const draggedH = mDrag ? Number(mDrag[2]) : 0;
        check(
            'C4: dragging the SE handle inward shrinks the crop rect',
            draggedW > 0 && draggedW < 300 && draggedH > 0 && draggedH < 220,
            dimsAfterDrag,
        );

        // ---------- Save and confirm the FileList badge + preview update ----------
        await page.click('#crop-modal .btn-primary'); // Save
        // The modal element stays mounted (just CSS visibility:hidden), so
        // waitForSelector's default state:'visible' would time out here --
        // poll the class directly instead.
        await page.waitForFunction(() => document.getElementById('crop-modal').classList.contains('hidden'));
        const cropBadgeText = await page.$eval('#file-item-0', el => el.innerText);
        check('C5: FileList shows a Crop badge after saving', /Crop:\s*\d+x\d+/.test(cropBadgeText), cropBadgeText);

        const res1 = await page.$eval('#file-resolution-0', el => el.innerText);
        const mRes1 = /(\d+)\s*x\s*(\d+)/.exec(res1);
        const expectedW = Math.round(draggedW * 0.5);
        const expectedH = Math.round(draggedH * 0.5);
        check(
            'C6: per-file resolution preview is now crop-adjusted then scaled',
            !!mRes1 && Math.abs(Number(mRes1[1]) - expectedW) <= 1 && Math.abs(Number(mRes1[2]) - expectedH) <= 1,
            `${res1} (expected ~${expectedW} x ${expectedH})`,
        );

        // ---------- Execute: real ffmpeg crop+scale, verify the output's actual dimensions ----------
        await page.evaluate(() => {
            const el = document.querySelector('#image-format');
            el.value = '.jpg';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const progressText = await runExecuteAndWait(page);
        check('C7: crop+scale batch completes', progressText.includes('Completed 1 of 1'), progressText);
        const outFile = path.join(FIXTURES_DIR, 'test_in_converted.jpg');
        check('C8: output file created', fs.existsSync(outFile), outFile);
        const log = await page.$eval('#terminal-log', el => el.innerText);
        const lastCmd = log.slice(log.lastIndexOf('> Executing:'));
        check('C9: executed command contains a crop= filter before scale=', /crop=\d+:\d+:\d+:\d+.*scale=/.test(lastCmd), lastCmd.slice(-400));

        if (fs.existsSync(outFile)) {
            // ffmpeg -i with no output always exits non-zero ("At least one
            // output file must be specified") even though it already wrote
            // the stream info we want to stderr -- same non-throwing intent
            // as useFileManager.js's own getMediaInfo probe, just via
            // execFileSync (which throws on nonzero exit) instead of
            // Neutralino's execCommand (which doesn't).
            let probe = '';
            try {
                probe = execFileSync(
                    path.join(PROJECT_ROOT, 'binaries', 'ffmpeg.exe'),
                    ['-i', outFile],
                    { stdio: 'pipe' },
                ).toString();
            } catch (e) {
                probe = (e.stderr || '').toString();
            }
            const dimMatch = /(?:,\s+)(\d+)x(\d+)(?:[,\s]|$)/.exec(probe);
            check(
                'C10: actual output dimensions match the crop-then-scale math',
                !!dimMatch && Math.abs(Number(dimMatch[1]) - expectedW) <= 2 && Math.abs(Number(dimMatch[2]) - expectedH) <= 2,
                `${dimMatch ? dimMatch[0] : 'no match'} (expected ~${expectedW} x ${expectedH})`,
            );
        }

        // ---------- Clear Crop round-trips to "no crop" ----------
        await page.click('#btn-crop-0');
        await page.waitForSelector('#crop-modal:not(.hidden)');
        await page.click('#crop-modal .btn-ghost'); // Clear Crop
        await page.click('#crop-modal .btn-primary'); // Save
        // The modal element stays mounted (just CSS visibility:hidden), so
        // waitForSelector's default state:'visible' would time out here --
        // poll the class directly instead.
        await page.waitForFunction(() => document.getElementById('crop-modal').classList.contains('hidden'));
        const afterClearText = await page.$eval('#file-item-0', el => el.innerText);
        check('C11: Clear Crop removes the Crop badge (round-trips to undefined)', !/Crop:/.test(afterClearText), afterClearText);

        check('G1: no page errors across the crop-UI suite', pageErrors.length === 0, pageErrors.join(' | '));
    } catch (e) {
        console.error('TEST HARNESS ERROR:', e);
        results.push({ name: 'harness completed', ok: false });
    } finally {
        if (browser) await browser.close().catch(() => {});
        try { cp.execSync(`taskkill /pid ${neu.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { /* already gone */ }
        cleanupNames.forEach(n => rmIfExists(path.join(FIXTURES_DIR, n)));
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
    if (failed.length) failed.forEach(f => console.log('FAILED:', f.name));
    process.exit(failed.length ? 1 : 0);
}

main();
