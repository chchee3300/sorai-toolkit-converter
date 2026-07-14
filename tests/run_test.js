const fs = require('fs');
const cp = require('child_process');
const { chromium } = require('playwright');
const os = require('os');

const neu = cp.spawn('cmd.exe', ['/c', 'neu run'], { stdio: 'pipe' });
const desktop = os.homedir() + '\\\\Desktop';

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
        
        // Pass a string instead of an object!
        await page.evaluate(() => {
            window.handleFiles(['e:\\\\資料\\\\tools\\\\FileConverterApp\\\\tests\\\\fixtures\\\\test.mp4']);
        });
        
        await page.waitForTimeout(1000);
        
        await page.evaluate((d) => {
            document.getElementById('video-fps').value = '15';
            window.outputPath = d;
        }, desktop);
        
        await page.click('#btn-execute');
        
        await page.waitForTimeout(3000);
        
        const termLog = await page.$eval('#terminal-log', el => el.innerText);
        console.log('TERM LOG:', termLog);
        
        const progText = await page.$eval('#progress-text', el => el.innerText);
        console.log('PROG TEXT:', progText);
        
        await browser.close();
        neu.kill();
        process.exit(0);
    } catch(e) {
        console.error(e);
        neu.kill();
        process.exit(1);
    }
}, 5000);
