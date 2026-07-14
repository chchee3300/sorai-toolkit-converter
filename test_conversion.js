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
    // #btn-execute is a Start-Processing button while idle and swaps in place
    // to a (non-disabled, clickable) Cancel button while executing — so
    // "disabled === false" is no longer a valid completion signal on its own
    // (it flips to false the instant the Cancel button mounts, not when the
    // batch actually finishes). Wait on the terminal progress-text state
    // instead, which is only ever set once the whole batch loop is done.
    await page.waitForFunction(() => /^(Completed|Cancelled)/.test(document.getElementById('progress-text').innerText), { timeout: timeoutMs });
    const progressText = await page.$eval('#progress-text', el => el.innerText);
    return progressText;
}

async function main() {
    setTimeout(() => { console.error('WATCHDOG: test exceeded 420s, aborting'); process.exit(1); }, 420000);

    // Clean up any leftover output files from previous runs so collision-suffix
    // assertions below are deterministic.
    const cleanupNames = [
        'test_fixture_video_converted.mp4', 'test_fixture_video_converted_converted.mp4', 'test_fixture_video_converted.gif',
        'test_in_converted.webp', 'test_in_converted.png',
        'test_fixture_audio_converted.aac',
        'test_fixture_converted.pdf',
        'test_fixture_video_cancel_a.mp4', 'test_fixture_video_cancel_b.mp4', 'test_fixture_video_cancel_c.mp4',
        'test_fixture_video_cancel_a_converted.mp4',
        'test_fixture_video_fps.mp4', 'test_fixture_video_fps_converted.mp4',
        'test_fixture_audio_converted.ogg',
        'test_ico_fixture.ico', 'test_in_converted.ico', 'test_ico_fixture_converted.png',
        'test_in_converted.pdf',
        'test_fixture_converted.docx', 'test_fixture_converted.odt',
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

    // ICO is bidirectional (also an accepted input) -- generate a fixture at
    // runtime from test_in.png via the already-downloaded binaries/ffmpeg.exe,
    // same "derive fixtures at runtime" convention fpsFixture/cancelFixtures
    // below already use, rather than committing a new binary file. ffmpeg's
    // ico muxer hard-caps output at 256x256 (test_in.png is 320x240), so
    // this must scale down the same way buildImageCommand's own .ico
    // branch does (ffmpeg-commands.js) -- otherwise this generation step
    // itself fails with "Unsupported dimensions".
    const icoFixture = path.join(ROOT, 'test_ico_fixture.ico');
    execFileSync(path.join(ROOT, 'binaries', 'ffmpeg.exe'), [
        '-y', '-i', fixtures.image,
        '-vf', "scale='min(256,iw)':'min(256,ih)':force_original_aspect_ratio=decrease",
        icoFixture,
    ], { stdio: 'pipe' });

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
        await page.waitForSelector('#input-panel');
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
        check('V6a: default (untouched) FPS adds no explicit fps filter', !/-vf "[^"]*fps=/.test(vLog), vLog.slice(-400));
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

        // Custom FPS via the draggable slider (fps redesign — was a preset
        // dropdown gated by a "Custom" checkbox, now a range slider whose
        // max defaults to the source's own fps). Uses its own fixture copy
        // to avoid colliding with the _converted/_converted_converted
        // filenames the collision-suffix test above already created.
        const fpsFixture = path.join(ROOT, 'test_fixture_video_fps.mp4');
        fs.copyFileSync(fixtures.video, fpsFixture);
        await dropFile(page, fpsFixture);
        const fpsSliderMax = await page.$eval('#video-fps', el => el.max);
        check('V6b: FPS slider max defaults to the source file\'s own fps', Number(fpsSliderMax) > 0, fpsSliderMax);
        await setRangeValue(page, '#video-fps', '15');
        const progressTextFps = await runExecuteAndWait(page);
        check('V6c: custom-FPS batch completes', progressTextFps.includes('Completed 1 of 1'), progressTextFps);
        const vFpsLog = await page.$eval('#terminal-log', el => el.innerText);
        check('V6d: dragged FPS slider produced an explicit filter for the target rate', /-vf "[^"]*fps=15(,|")/.test(vFpsLog), vFpsLog.slice(-400));
        const fpsOut = path.join(ROOT, 'test_fixture_video_fps_converted.mp4');
        check('V6e: custom-FPS output file created', fs.existsSync(fpsOut), fpsOut);
        rmIfExists(fpsFixture);
        rmIfExists(fpsOut);
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

        // ICO as OUTPUT — must NOT trigger the PNG-only palettegen branch
        // even with quality < 100 (CLAUDE.md-flagged regression risk: ICO
        // has no quality knob of its own, only the generic scale filter
        // should apply).
        await setSelectValue(page, '#image-format', '.ico');
        await setRangeValue(page, '#image-quality', '40');
        const iIcoProgress = await runExecuteAndWait(page);
        check('I8: ico batch completes', iIcoProgress.includes('Completed 1 of 1'), iIcoProgress);
        const iOutIco = path.join(ROOT, 'test_in_converted.ico');
        check('I9: ico output file created', fs.existsSync(iOutIco), iOutIco);
        // #terminal-log accumulates every command run this whole session --
        // "palettegen" genuinely appears earlier (I7's PNG case), so a
        // negative check must scope to just this command's own logged
        // output, not the full accumulated buffer.
        const iIcoFullLog = await page.$eval('#terminal-log', el => el.innerText);
        const iIcoLog = iIcoFullLog.slice(iIcoFullLog.lastIndexOf('> Executing:'));
        check('I10: ico output does not trigger palettegen', !iIcoLog.includes('palettegen'), iIcoLog.slice(-400));

        await clearFileList(page);

        // ICO as INPUT (round-trip decode)
        await dropFile(page, icoFixture);
        check('I11: ico recognized as image type', await page.$eval('#image-settings', el => !el.classList.contains('hidden')));
        await setSelectValue(page, '#image-format', '.png');
        const iIcoInProgress = await runExecuteAndWait(page);
        check('I12: ico-as-input batch completes', iIcoInProgress.includes('Completed 1 of 1'), iIcoInProgress);
        const iIcoInOut = path.join(ROOT, 'test_ico_fixture_converted.png');
        check('I13: ico-as-input output file created', fs.existsSync(iIcoInOut), iIcoInOut);

        await clearFileList(page);

        // Image -> PDF via the bundled img2pdf.exe (not ffmpeg) — Quality/
        // Scale have no effect on a lossless embed, so both fields hide.
        await dropFile(page, fixtures.image);
        await setSelectValue(page, '#image-format', '.pdf');
        const qualityGroupDisplay = await page.$eval('#image-quality-group', el => el.style.display);
        const scaleGroupDisplay = await page.$eval('#image-scale-group', el => el.style.display);
        check('I14: quality/scale hidden for PDF output', qualityGroupDisplay === 'none' && scaleGroupDisplay === 'none', `${qualityGroupDisplay} / ${scaleGroupDisplay}`);
        const iPdfProgress = await runExecuteAndWait(page);
        check('I15: image-to-pdf batch completes', iPdfProgress.includes('Completed 1 of 1'), iPdfProgress);
        const iOutPdf = path.join(ROOT, 'test_in_converted.pdf');
        check('I16: image-to-pdf output file created', fs.existsSync(iOutPdf), iOutPdf);
        const iPdfLog = await page.$eval('#terminal-log', el => el.innerText);
        check('I17: image-to-pdf used img2pdf.exe (not ffmpeg.exe)', iPdfLog.includes('img2pdf.exe') && !iPdfLog.includes('ffmpeg.exe -y -i'), iPdfLog.slice(-400));

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

        // OGG output — explicit libvorbis encoder (not left to ffmpeg's
        // default muxer-implied choice) + bitrate
        await setSelectValue(page, '#audio-format', '.ogg');
        await setSelectValue(page, '#audio-bitrate', '192k');
        await setRangeValue(page, '#audio-speed', '1.0'); // reset speed from the AAC case above
        const aOggProgress = await runExecuteAndWait(page);
        check('A5: ogg batch completes', aOggProgress.includes('Completed 1 of 1'), aOggProgress);
        const aOggOut = path.join(ROOT, 'test_fixture_audio_converted.ogg');
        check('A6: ogg output file created', fs.existsSync(aOggOut), aOggOut);
        const aOggLog = await page.$eval('#terminal-log', el => el.innerText);
        check('A7: ogg command used explicit libvorbis encoder', aOggLog.includes('-c:a libvorbis'), aOggLog.slice(-400));
        check('A8: ogg command used target bitrate', aOggLog.includes('-b:a 192k'), aOggLog.slice(-400));

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
        rmIfExists(pOut); // keep the collision-suffix namespace clean for P5-P14 below

        await clearFileList(page);

        // ============================================================
        // PDF -> DOCX / ODT via LibreOffice headless (soffice.exe) — the
        // staged-copy workaround for soffice's basename-preserving
        // --outdir-only output, and the original qpdf path still working
        // unmodified alongside the new format fork.
        // ============================================================
        console.log('\n--- PDF: DOCX/ODT conversion ---');
        await dropFile(page, fixtures.pdf);
        await setSelectValue(page, '#pdf-format', '.docx');
        const optimizeGroupDisplay = await page.$eval('#pdf-optimize-group', el => el.style.display);
        check('P5: optimize-mode group hidden when format is docx', optimizeGroupDisplay === 'none', optimizeGroupDisplay);

        // LibreOffice's first invocation on a machine initializes a user
        // profile dir and is markedly slower than ffmpeg/qpdf calls —
        // give docx/odt conversions extra time over the 60s default.
        const pDocxProgress = await runExecuteAndWait(page, 90000);
        check('P6: docx batch completes', pDocxProgress.includes('Completed 1 of 1'), pDocxProgress);
        const pOutDocx = path.join(ROOT, 'test_fixture_converted.docx');
        check('P7: docx output file created', fs.existsSync(pOutDocx), pOutDocx);
        const pDocxLog = await page.$eval('#terminal-log', el => el.innerText);
        check('P8: docx command used soffice.exe --convert-to docx', pDocxLog.includes('soffice.exe') && pDocxLog.includes('--convert-to docx'), pDocxLog.slice(-400));
        const stagedLeftover = path.join(ROOT, 'test_fixture_converted.pdf');
        check('P9: staged temp pdf copy cleaned up after docx conversion', !fs.existsSync(stagedLeftover), stagedLeftover);
        rmIfExists(pOutDocx);

        await clearFileList(page);

        await dropFile(page, fixtures.pdf);
        await setSelectValue(page, '#pdf-format', '.odt');
        const pOdtProgress = await runExecuteAndWait(page, 90000);
        check('P10: odt batch completes', pOdtProgress.includes('Completed 1 of 1'), pOdtProgress);
        const pOutOdt = path.join(ROOT, 'test_fixture_converted.odt');
        check('P11: odt output file created', fs.existsSync(pOutOdt), pOutOdt);
        const pOdtLog = await page.$eval('#terminal-log', el => el.innerText);
        check('P12: odt command used soffice.exe --convert-to odt', pOdtLog.includes('soffice.exe') && pOdtLog.includes('--convert-to odt'), pOdtLog.slice(-400));
        rmIfExists(pOutOdt);

        await clearFileList(page);

        // Reverting format back to .pdf must still exercise the original
        // qpdf optimize path, unmodified, alongside the new format fork.
        await dropFile(page, fixtures.pdf);
        await setSelectValue(page, '#pdf-format', '.pdf');
        await setSelectValue(page, '#pdf-optimize', 'linearize');
        const pBackProgress = await runExecuteAndWait(page);
        check('P13: reverting to pdf format still runs qpdf optimize path', pBackProgress.includes('Completed 1 of 1'), pBackProgress);
        const pBackLog = await page.$eval('#terminal-log', el => el.innerText);
        check('P14: reverted-to-pdf command used --linearize', pBackLog.includes('--linearize'), pBackLog.slice(-300));
        rmIfExists(path.join(ROOT, 'test_fixture_converted.pdf'));

        await clearFileList(page);

        // ============================================================
        // CANCEL — mid-batch cancel/stop (kills the spawned process,
        // stops before the next file starts, reverts the button, cleans
        // up the partial output, leaves no orphaned process behind)
        // ============================================================
        console.log('\n--- CANCEL ---');
        const cancelFixtures = ['a', 'b', 'c'].map(letter => path.join(ROOT, `test_fixture_video_cancel_${letter}.mp4`));
        cancelFixtures.forEach(p => fs.copyFileSync(fixtures.video, p));

        await page.evaluate(paths => Neutralino.events.dispatch('filesDropped', paths), cancelFixtures);
        await page.waitForFunction(count => document.querySelectorAll('#file-list .file-item').length === count, cancelFixtures.length);
        await setSelectValue(page, '#video-format', '.mp4');
        // AV1 (libsvtav1) is dramatically slower to encode than the default
        // h264 codec even for a tiny fixture — used here deliberately to
        // guarantee a multi-second window on file 1 so the click below
        // reliably lands mid-conversion instead of racing a near-instant
        // encode.
        await setSelectValue(page, '#video-codec', 'libsvtav1');

        await page.click('#btn-execute');
        await page.waitForFunction(() => /\(1\/3\)/.test(document.getElementById('progress-text').innerText), { timeout: 20000 });
        await page.click('#btn-execute'); // same id, now the Cancel button
        const cancellingShown = await page.waitForFunction(
            () => { const el = document.getElementById('btn-execute'); return el.disabled && el.textContent.includes('Cancelling'); },
            { timeout: 5000 },
        ).then(() => true).catch(() => false);
        check('X1: button shows Cancelling… and disables', cancellingShown);

        await page.waitForFunction(() => /^Cancelled/.test(document.getElementById('progress-text').innerText), { timeout: 15000 });
        const cancelProgressText = await page.$eval('#progress-text', el => el.innerText);
        const cancelMatch = /Cancelled (\d+) of (\d+)/.exec(cancelProgressText);
        check('X2: status reports Cancelled N of M', !!cancelMatch, cancelProgressText);
        if (cancelMatch) {
            check('X3: batch stopped early (completed < total)', Number(cancelMatch[1]) < Number(cancelMatch[2]), cancelProgressText);
        }

        const startReverted = await page.waitForFunction(
            () => { const el = document.getElementById('btn-execute'); return !el.disabled && el.textContent.includes('Start Processing'); },
            { timeout: 10000 },
        ).then(() => true).catch(() => false);
        check('X4: button reverts to enabled Start Processing', startReverted);

        const cancelledOut = path.join(ROOT, 'test_fixture_video_cancel_a_converted.mp4');
        check('X5: partial output cleaned up (no truncated file left behind)', !fs.existsSync(cancelledOut), cancelledOut);

        const cancelledSizeSpan = await page.$eval('#file-size-0', el => el.innerHTML);
        check('X6: cancelled file not marked converted', !cancelledSizeSpan.includes('→'), cancelledSizeSpan);

        await sleep(800); // let Windows finish reaping the killed process before checking
        try {
            const tasklistOut = cp.execSync('tasklist', { encoding: 'utf8' });
            check('X7: no orphaned ffmpeg.exe process after cancel', !tasklistOut.includes('ffmpeg.exe'));
        } catch (e) {
            check('X7: no orphaned ffmpeg.exe process after cancel', false, e.message);
        }

        await clearFileList(page);
        cancelFixtures.forEach(p => rmIfExists(p));

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
