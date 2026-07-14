const cp = require('child_process');

const binPath = 'e:\\\\資料\\\\tools\\\\FileConverterApp\\\\binaries\\\\ffmpeg.exe';
const inFile = 'e:\\\\資料\\\\tools\\\\FileConverterApp\\\\tests\\\\fixtures\\\\test.mp4';
const testPng = 'e:\\\\資料\\\\tools\\\\FileConverterApp\\\\tests\\\\fixtures\\\\test_in.png';
const outPng = 'e:\\\\資料\\\\tools\\\\FileConverterApp\\\\tests\\\\fixtures\\\\test_out.png';

// Create a test PNG first
cp.execSync(`\"${binPath}\" -y -i \"${inFile}\" -vframes 1 \"${testPng}\"`);

// Try compressing it
const cmd = `\"${binPath}\" -y -i \"${testPng}\" -compression_level 100 \"${outPng}\"`;
console.log('Running:', cmd);

cp.exec(cmd, (err, stdout, stderr) => {
    if(err) {
        console.log('Error:', err.message);
    } else {
        console.log('Success!');
    }
});
