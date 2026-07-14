const fs = require('fs');
const cp = require('child_process');
const { chromium } = require('playwright');
const os = require('os');

const neu = cp.spawn('cmd.exe', ['/c', 'neu run'], { stdio: 'pipe' });

setTimeout(async () => {
    try {
        const auth = JSON.parse(fs.readFileSync('.tmp/auth_info.json', 'utf8'));
        const url = 'http://localhost:' + auth.nlPort + '/?nlToken=' + auth.nlToken;
        
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        
        await page.goto(url);
        await page.waitForTimeout(2000);
        
        const result = await page.evaluate(() => {
            return Object.keys(Neutralino);
        });
        console.log('Neutralino keys:', result);
        
        const fsKeys = await page.evaluate(() => Object.keys(Neutralino.filesystem || {}));
        console.log('Neutralino.filesystem keys:', fsKeys);

        const osKeys = await page.evaluate(() => Object.keys(Neutralino.os || {}));
        console.log('Neutralino.os keys:', osKeys);

        const customKeys = await page.evaluate(() => Object.keys(Neutralino.custom || {}));
        console.log('Neutralino.custom keys:', customKeys);
        
        await browser.close();
        neu.kill();
        process.exit(0);
    } catch(e) {
        console.error(e);
        neu.kill();
        process.exit(1);
    }
}, 3000);
