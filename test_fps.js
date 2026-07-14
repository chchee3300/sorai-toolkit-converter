const cp = require('child_process');
const cmd = '\"e:\\\\資料\\\\tools\\\\FileConverterApp\\\\binaries\\\\ffmpeg.exe\" -y -i \"e:\\\\資料\\\\tools\\\\FileConverterApp\\\\test.mp4\" -c:v libx264 -vf \"fps=30\" -b:v 11k -bufsize 22k \"e:\\\\資料\\\\tools\\\\FileConverterApp\\\\test_fps.mp4\"';
console.log('Running:', cmd);
cp.exec(cmd, (err, stdout, stderr) => {
    console.log('stderr:', stderr);
    if(err) console.log('ERROR:', err);
});
