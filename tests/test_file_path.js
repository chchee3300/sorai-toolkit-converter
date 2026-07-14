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
            const dt = new DataTransfer();
            const f = new File(["foo"], "foo.txt", { type: "text/plain" });
            dt.items.add(f);
            const file = dt.files[0];
            return {
                hasPath: 'path' in file,
                pathValue: file.path,
                keys: Object.keys(file)
            };
        });
        console.log('FILE PROPERTIES:', result);
        
        await browser.close();
        neu.kill();
        process.exit(0);
    } catch(e) {
        console.error(e);
        neu.kill();
        process.exit(1);
    }
}, 3000);
