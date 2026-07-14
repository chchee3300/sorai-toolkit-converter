$ErrorActionPreference = "Stop"

$binDir = ".\binaries"
If (!(Test-Path $binDir)) {
    New-Item -ItemType Directory -Force -Path $binDir
}

Write-Host "Downloading ffmpeg..."
$ffmpegZip = "$binDir\ffmpeg.zip"
Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" -OutFile $ffmpegZip
Expand-Archive -Path $ffmpegZip -DestinationPath "$binDir\ffmpeg_temp" -Force
Copy-Item "$binDir\ffmpeg_temp\*\bin\ffmpeg.exe" -Destination "$binDir\ffmpeg.exe" -Force
Remove-Item $ffmpegZip -Force
Remove-Item "$binDir\ffmpeg_temp" -Recurse -Force

Write-Host "Downloading qpdf..."
$qpdfZip = "$binDir\qpdf.zip"
Invoke-WebRequest -Uri "https://github.com/qpdf/qpdf/releases/download/v12.3.2/qpdf-12.3.2-mingw64.zip" -OutFile $qpdfZip
Expand-Archive -Path $qpdfZip -DestinationPath "$binDir\qpdf_temp" -Force
$qpdfExe = Get-ChildItem -Path "$binDir\qpdf_temp" -Filter "qpdf.exe" -Recurse | Select-Object -First 1
if ($qpdfExe) { Copy-Item $qpdfExe.FullName -Destination "$binDir\qpdf.exe" -Force }
$qpdfDlls = Get-ChildItem -Path "$binDir\qpdf_temp" -Filter "libqpdf*.dll" -Recurse
if ($qpdfDlls) { Copy-Item $qpdfDlls.FullName -Destination "$binDir\" -Force }
Remove-Item $qpdfZip -Force
Remove-Item "$binDir\qpdf_temp" -Recurse -Force

Write-Host "ImageMagick download was skipped due to archive link changes."
Write-Host "Please place magick.exe inside the binaries folder manually if you need Image conversion."

Write-Host "All binaries downloaded successfully!"
