// Golden-master regression suite for all 4 conversion categories + shared behaviors.
// Reuses test_drop.js's neu-launch/auth/teardown pattern (see [[neu-playwright-test-pattern]]).
// Drives the REAL app UI end-to-end (real ffmpeg/qpdf subprocess execution), per
// CLAUDE.md's mandatory Video/Image/Audio/PDF + shared-feature regression policy.
// Run with: node test_conversion.js
// Exits 0 on success, 1 on any failure.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { chromium } = require('playwright');

const ROOT = __dirname;
const { execFileSync } = cp;

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
                const st = fs.statSync(path.join(ROOT, '.tmp', 'auth_info.json'));
                if (st.mtimeMs > sinceMs) return resolve();
            } catch (e) { /* not written yet */ }
            if (Date.now() - t0 > timeoutMs) return reject(new Error('auth_info.json not refreshed within ' + timeoutMs + 'ms'));
            setTimeout(poll, 500);
        })();
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function rmIfExists(p) { try { fs.unlinkSync(p); } catch (e) { /* fine */ } }

async function clearFileList(page) {
    if (await page.$('#file-list .file-item')) {
        await page.click('#btn-clear-files');
        await page.waitForFunction(() => document.querySelectorAll('#file-list .file-item').length === 0);
    }
}

// The app wraps every <select class="input"> in a custom liquid-glass dropdown
// (liquid-glass.js LiquidSelect) that sets the native <select> to display:none,
// so Playwright's selectOption() (which requires visibility) hangs. Mirror what
// LiquidSelect's own option-click handler does instead: set .value, then fire
// change + input (both bubbling) — see liquid-glass.js:308-315.
async function setSelectValue(page, selector, value) {
    await page.evaluate(({ selector, value }) => {
        const el = document.querySelector(selector);
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { selector, value });
}

// Playwright's page.fill() is unreliable on type="range" inputs (works once,
// then throws "Malformed value" on a later call in practice). Set the value
// directly and fire input+change, same events the browser's own slider drag
// would dispatch. Must go through the native property setter, not a plain
// `el.value = x` assignment — React overrides the value setter on
// controlled inputs to track "real" user-driven changes, so a plain
// assignment silently no-ops against the React build (confirmed in
// design-system/MASTER.md's Phase 2.2+2.3+2.4 decisions). The native
// setter bypass works against both the vanilla and the React app.
async function setRangeValue(page, selector, value) {
    await page.evaluate(({ selector, value }) => {
        const el = document.querySelector(selector);
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { selector, value });
}

async function dropFile(page, absPath) {
    await page.evaluate(p => Neutralino.events.dispatch('filesDropped', [p]), absPath);
    await page.waitForSelector('#file-list .file-item', { timeout: 20000 });
}

async function runExecuteAndWait(page, timeoutMs = 60000) {
    await page.click('#btn-execute');
    // btn-execute is re-enabled once the whole batch loop finishes
    await page.waitForFunction(() => document.getElementById('btn-execute').disabled === false, { timeout: timeoutMs });
    const progressText = await page.$eval('#progress-text', el => el.innerText);
    return progressText;
}

async function main() {
    setTimeout(() => { console.error('WATCHDOG: test exceeded 240s, aborting'); process.exit(1); }, 240000);

    // Clean up any leftover output files from previous runs so collision-suffix
    // assertions below are deterministic.
    const cleanupNames = [
        'test_fixture_video_converted.mp4', 'test_fixture_video_converted_converted.mp4', 'test_fixture_video_converted.gif',
        'test_in_converted.webp', 'test_in_converted.png',
        'test_fixture_audio_converted.aac',
        'test_fixture_converted.pdf',
    ];
    cleanupNames.forEach(n => rmIfExists(path.join(ROOT, n)));

    const fixtures = {
        video: path.join(ROOT, 'test_fixture_video.mp4'),
        image: path.join(ROOT, 'test_in.png'),
        audio: path.join(ROOT, 'test_fixture_audio.mp3'),
        pdf: path.join(ROOT, 'test_fixture.pdf'),
    };
    for (const [k, p] of Object.entries(fixtures)) {
        if (!fs.existsSync(p)) { console.error(`Fixture missing (${k}): ${p}`); process.exit(1); }
    }

    const env = { ...process.env, PATH: process.env.PATH + ';' + path.join(process.env.APPDATA || '', 'npm') };
    const launchTime = Date.now();
    const neu = cp.spawn('cmd.exe', ['/c', 'neu run -- --export-auth-info'], { stdio: 'pipe', cwd: ROOT, env });
    neu.stdout.on('data', d => process.stdout.write('[neu] ' + d));
    neu.stderr.on('data', d => process.stderr.write('[neu:err] ' + d));
    let browser = null;
    const pageErrors = [];

    try {
        await waitForAuthInfo(launchTime);
        const auth = JSON.parse(fs.readFileSync(path.join(ROOT, '.tmp', 'auth_info.json'), 'utf8'));
        const url = 'http://localhost:' + auth.nlPort + '/?nlToken=' + auth.nlToken;
        console.log('Connecting to', url);

        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.on('pageerror', err => { pageErrors.push(err.message); console.log('PAGE ERROR:', err.message); });
        page.on('dialog', d => { console.log('PAGE DIALOG:', d.message()); d.dismiss().catch(() => {}); });
        await page.addInitScript(t => { try { sessionStorage.setItem('NL_TOKEN', t); } catch (e) {} }, auth.nlToken);
        await page.goto(url);
        await page.waitForSelector('#drop-zone');
        // React build has no window.importDroppedFiles global (it's an
        // internal hook callback now) — wait on NL_MODE + Neutralino
        // instead, both still genuine Neutralino-injected globals.
        await page.waitForFunction(() => typeof window.NL_MODE !== 'undefined' && typeof window.Neutralino !== 'undefined');

        // ============================================================
        // VIDEO — format switch, encoder auto-hide (GIF), FPS calc,
        // quality/bitrate, speed (atempo), filename-collision suffix
        // ============================================================
        console.log('\n--- VIDEO ---');
        await dropFile(page, fixtures.video);
        check('V0: settings panel shows video settings', await page.$eval('#video-settings', el => !el.classList.contains('hidden')));
        check('V0b: type badge says Video', (await page.$eval('#type-badge', el => el.textContent)) === 'Video');
        const vEstBefore = await page.$eval('#file-est-0', el => el.innerHTML);
        check('V1: live size estimate shown before conversion', vEstBefore.includes('→ ~'), vEstBefore);

        // quality 50%, speed 1.5x (exercises atempo + setpts), keep codec default (libx264)
        await setRangeValue(page, '#video-quality', '50');
        await setRangeValue(page, '#video-speed', '1.5');

        const progressText1 = await runExecuteAndWait(page);
        check('V2: batch completion message', progressText1.includes('Completed 1 of 1'), progressText1);
        const vOut = path.join(ROOT, 'test_fixture_video_converted.mp4');
        check('V3: output file created', fs.existsSync(vOut), vOut);
        const vLog = await page.$eval('#terminal-log', el => el.innerText);
        check('V4: command used libx264 codec', vLog.includes('-c:v libx264'));
        check('V5: command used bitrate targeting (duration known)', /-b:v \d+k -bufsize \d+k/.test(vLog), vLog.slice(-400));
        check('V6: speed 1.5x produced setpts + atempo filters', vLog.includes('setpts=') && vLog.includes('atempo=1.5'), vLog.slice(-400));
        const vSizeSpan = await page.$eval('#file-size-0', el => el.innerHTML);
        check('V7: real converted size shown after execute', vSizeSpan.includes('→'), vSizeSpan);
        const vEstAfter = await page.$eval('#file-est-0', el => el.innerHTML);
        check('V8: estimate cleared after real result known', vEstAfter === '', vEstAfter);

        // Filename-collision: run again on the same (still-loaded) file
        const progressText2 = await runExecuteAndWait(page);
        check('V9: second run also completes', progressText2.includes('Completed 1 of 1'), progressText2);
        const vOut2 = path.join(ROOT, 'test_fixture_video_converted_converted.mp4');
        check('V10: filename-collision suffix applied (_converted_converted)', fs.existsSync(vOut2), vOut2);

        await clearFileList(page);

        // GIF path: encoder group auto-hide + palettegen
        await dropFile(page, fixtures.video);
        await setSelectValue(page, '#video-format', '.gif');
        const codecGroupDisplay = await page.$eval('#video-codec-group', el => el.style.display);
        check('V11: codec selector auto-hidden for GIF format', codecGroupDisplay === 'none', codecGroupDisplay);
        await setRangeValue(page, '#video-speed', '1.0'); // reset speed from previous case
        const progressText3 = await runExecuteAndWait(page);
        check('V12: GIF batch completes', progressText3.includes('Completed 1 of 1'), progressText3);
        const vGifOut = path.join(ROOT, 'test_fixture_video_converted.gif');
        check('V13: GIF output file created', fs.existsSync(vGifOut), vGifOut);
        const vGifLog = await page.$eval('#terminal-log', el => el.innerText);
        check('V14: GIF command used palettegen/paletteuse', vGifLog.includes('palettegen') && vGifLog.includes('paletteuse'), vGifLog.slice(-400));

        await clearFileList(page);

        // ============================================================
        // IMAGE — format switch, quality (PNG palettegen path), scale
        // ============================================================
        console.log('\n--- IMAGE ---');
        await dropFile(page, fixtures.image);
        check('I0: settings panel shows image settings', await page.$eval('#image-settings', el => !el.classList.contains('hidden')));

        await setSelectValue(page, '#image-format', '.webp');
        await setRangeValue(page, '#image-quality', '60');
        await setRangeValue(page, '#image-scale', '50');
        const resPreview = await page.$eval('#image-resolution-preview', el => el.innerText);
        check('I1: resolution preview updates with scale', resPreview.length > 0, resPreview);

        const iProgress1 = await runExecuteAndWait(page);
        check('I2: webp batch completes', iProgress1.includes('Completed 1 of 1'), iProgress1);
        const iOutWebp = path.join(ROOT, 'test_in_converted.webp');
        check('I3: webp output file created', fs.existsSync(iOutWebp), iOutWebp);
        const iLog1 = await page.$eval('#terminal-log', el => el.innerText);
        check('I4: webp command used -q:v and scale filter', iLog1.includes('-q:v 60') && iLog1.includes('scale='), iLog1.slice(-400));

        // PNG with quality < 100 must trigger the palettegen path (CLAUDE.md-flagged)
        await setSelectValue(page, '#image-format', '.png');
        await setRangeValue(page, '#image-quality', '40');
        const iProgress2 = await runExecuteAndWait(page);
        check('I5: png batch completes', iProgress2.includes('Completed 1 of 1'), iProgress2);
        const iOutPng = path.join(ROOT, 'test_in_converted.png');
        check('I6: png output file created', fs.existsSync(iOutPng), iOutPng);
        const iLog2 = await page.$eval('#terminal-log', el => el.innerText);
        check('I7: PNG quality<100 triggers palettegen path', iLog2.includes('palettegen=max_colors=') && iLog2.includes('paletteuse'), iLog2.slice(-400));

        await clearFileList(page);

        // ============================================================
        // AUDIO — format switch, bitrate control, speed (atempo)
        // ============================================================
        console.log('\n--- AUDIO ---');
        await dropFile(page, fixtures.audio);
        check('A0: settings panel shows audio settings', await page.$eval('#audio-settings', el => !el.classList.contains('hidden')));

        await setSelectValue(page, '#audio-format', '.aac');
        await setSelectValue(page, '#audio-bitrate', '128k');
        await setRangeValue(page, '#audio-speed', '2.0');

        const aProgress = await runExecuteAndWait(page);
        check('A1: audio batch completes', aProgress.includes('Completed 1 of 1'), aProgress);
        const aOut = path.join(ROOT, 'test_fixture_audio_converted.aac');
        check('A2: output file created', fs.existsSync(aOut), aOut);
        const aLog = await page.$eval('#terminal-log', el => el.innerText);
        check('A3: command used target bitrate', aLog.includes('-b:a 128k'), aLog.slice(-400));
        check('A4: speed 2.0x produced atempo filter', aLog.includes('atempo=2'), aLog.slice(-400));

        await clearFileList(page);

        // ============================================================
        // PDF — optimize modes (compress / linearize), qpdf validity
        // ============================================================
        console.log('\n--- PDF ---');
        await dropFile(page, fixtures.pdf);
        check('P0: settings panel shows pdf settings', await page.$eval('#pdf-settings', el => !el.classList.contains('hidden')));

        await setSelectValue(page, '#pdf-optimize', 'compress');
        const pProgress = await runExecuteAndWait(page);
        check('P1: pdf batch completes', pProgress.includes('Completed 1 of 1'), pProgress);
        const pOut = path.join(ROOT, 'test_fixture_converted.pdf');
        check('P2: output file created', fs.existsSync(pOut), pOut);
        const pLog = await page.$eval('#terminal-log', el => el.innerText);
        check('P3: compress mode used --stream-data=compress', pLog.includes('--stream-data=compress'), pLog.slice(-300));
        if (fs.existsSync(pOut)) {
            try {
                execFileSync(path.join(ROOT, 'binaries', 'qpdf.exe'), ['--check', pOut], { stdio: 'pipe' });
                check('P4: qpdf --check validates compressed output', true);
            } catch (e) {
                check('P4: qpdf --check validates compressed output', false, e.message);
            }
        } else {
            check('P4: qpdf --check validates compressed output', false, 'no output file');
        }

        await clearFileList(page);

        // ---------- Global invariants ----------
        check('G1: no page errors across whole suite', pageErrors.length === 0, pageErrors.join(' | '));
    } catch (e) {
        console.error('TEST HARNESS ERROR:', e);
        results.push({ name: 'harness completed', ok: false });
    } finally {
        if (browser) await browser.close().catch(() => {});
        try { cp.execSync(`taskkill /pid ${neu.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { /* already gone */ }
        cleanupNames.forEach(n => rmIfExists(path.join(ROOT, n)));
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
    if (failed.length) failed.forEach(f => console.log('FAILED:', f.name));
    process.exit(failed.length ? 1 : 0);
}

main();
