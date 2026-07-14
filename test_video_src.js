const fs = require('fs');
const cp = require('child_process');
const { chromium } = require('playwright');
const os = require('os');

const neu = cp.spawn('cmd.exe', ['/c', 'neu run'], { stdio: 'pipe' });
const desktop = os.homedir() + '\\Desktop';

setTimeout(async () => {
    try {
        const auth = JSON.parse(fs.readFileSync('.tmp/auth_info.json', 'utf8'));
        const url = 'http://localhost:' + auth.nlPort + '/?nlToken=' + auth.nlToken;
        console.log('Connecting to', url);
        
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

        await page.goto(url);
        await page.waitForTimeout(2000);
        
        // Test loading video
        const canPlay = await page.evaluate(async () => {
            return new Promise((resolve) => {
                let v = document.createElement('video');
                v.src = 'file:///e:/資料/tools/FileConverterApp/test.mp4';
                v.onloadedmetadata = () => resolve(true);
                v.onerror = (e) => resolve(v.error ? v.error.message : 'error');
                document.body.appendChild(v);
                setTimeout(() => resolve('timeout'), 2000);
            });
        });
        console.log('CAN PLAY FILE:// URL?', canPlay);
        
        await browser.close();
        neu.kill();
        process.exit(0);
    } catch(e) {
        console.error(e);
        neu.kill();
        process.exit(1);
    }
}, 3000);
