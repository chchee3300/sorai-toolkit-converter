const cp = require('child_process');
const cmd = '\"e:\\\\資料\\\\tools\\\\FileConverterApp\\\\binaries\\\\ffmpeg.exe\" -i \"e:\\\\資料\\\\tools\\\\FileConverterApp\\\\test.mp4\"';
cp.exec(cmd, (err, stdout, stderr) => {
    let match = stderr.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/);
    let fpsMatch = stderr.match(/(\d+(?:\.\d+)?)\s+fps/);
    console.log('fps match:', fpsMatch ? fpsMatch[1] : 'none');
});
