const fs = require('fs');
const cp = require('child_process');

const binPath = 'e:\\\\資料\\\\tools\\\\FileConverterApp\\\\binaries\\\\ffmpeg.exe';
const inFile = 'e:\\\\資料\\\\tools\\\\FileConverterApp\\\\tests\\\\fixtures\\\\test.mp4';
const desktopPath = require('os').homedir() + '\\\\Desktop';
const outPath = desktopPath + '\\\\test_converted.mp4';

const cmd = `\"${binPath}\" -y -i \"${inFile}\" -c:v libx264 -b:v 11k \"${outPath}\"`;
console.log('Running:', cmd);

cp.exec(cmd, (err, stdout, stderr) => {
    console.log('Finished with err:', err ? err.message : null);
    if(fs.existsSync(outPath)) {
        console.log('File EXISTS on desktop. Size:', fs.statSync(outPath).size);
    } else {
        console.log('File DOES NOT EXIST on desktop!');
    }
});
