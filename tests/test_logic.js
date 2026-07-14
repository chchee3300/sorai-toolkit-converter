const filesList = [{ path: 'C:/test.mp4', size: 1024*1024, duration: 10 }];
const outputPath = 'C:\\temp';
const NL_PATH = 'e:/資料/tools/FileConverterApp';
const currentFileType = 'video';

const document = {
    getElementById: (id) => {
        const mocks = {
            'btn-execute': { disabled: false },
            'progress-wrapper': { classList: { remove: ()=>{}, add: ()=>{} } },
            'progress-bar': { style: {} },
            'progress-text': { innerText: '' },
            'video-format': { value: '.mp4' },
            'video-codec': { value: 'libx264' },
            'video-quality': { value: '18' },
            'terminal-log': { innerText: '', scrollTop: 0, scrollHeight: 100 }
        };
        if (!mocks[id]) throw new Error('Missing mock for ' + id);
        return mocks[id];
    }
};

async function run() {
    const btn = document.getElementById('btn-execute');
    const progressWrapper = document.getElementById('progress-wrapper');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

    btn.disabled = true;
    progressWrapper.classList.remove('hidden');
    let completed = 0;

    for (let i = 0; i < filesList.length; i++) {
        const fileObj = filesList[i];
        const file = fileObj.path;
        const filename = file.split(/[\\/]/).pop();
        const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));
        const ext = filename.split('.').pop();
        const binPath = NL_PATH.replace(/\//g, '\\');
        
        progressText.innerText = `Processing: ${filename} (${i + 1}/${filesList.length})`;
        progressBar.style.width = `${((i) / filesList.length) * 100}%`;
        
        let command = '';
        
        if (currentFileType === 'video') {
            const format = document.getElementById('video-format').value;
            const codec = document.getElementById('video-codec').value;
            const qualityPercent = document.getElementById('video-quality').value;
            
            let targetBitrateCmd = '';
            if (fileObj.duration > 0) {
                const originalBitrateKbps = (fileObj.size * 8) / (fileObj.duration * 1024);
                const targetBitrateKbps = Math.max(10, Math.floor(originalBitrateKbps * (qualityPercent / 100)));
                targetBitrateCmd = `-b:v ${targetBitrateKbps}k -bufsize ${targetBitrateKbps * 2}k`;
            } else {
                const crf = 51 - Math.round((qualityPercent / 100) * 51);
                targetBitrateCmd = `-crf ${crf}`;
            }
            const outName = `${nameWithoutExt}_converted${format}`;
            const outPath = `${outputPath}\\${outName}`;
            
            command = `"${binPath}\\binaries\\ffmpeg.exe" -y -i "${file}" -c:v ${codec} ${targetBitrateCmd} "${outPath}"`;
        }

        if (command) {
            let term = document.getElementById('terminal-log');
            term.innerText += `\n> Executing: ${command}\n`;
            console.log("Terminal log updated:", term.innerText);
        }
    }
}
run().catch(console.error);
