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

Write-Host "Downloading img2pdf..."
# Pinned release (verify for a newer tag at https://gitlab.mister-muffin.de/josch/img2pdf/releases
# before assuming this URL still resolves — this host has no GitHub-style
# floating "latest" alias like the ffmpeg download above).
$img2pdfVersion = "0.5.1"
Invoke-WebRequest -Uri "https://gitlab.mister-muffin.de/josch/img2pdf/releases/download/$img2pdfVersion/img2pdf.exe" -OutFile "$binDir\img2pdf.exe"

Write-Host "Downloading LibreOffice Portable (this is large: ~280MB download, ~900MB-1.4GB extracted)..."
# Pinned release (verify for a newer version at
# https://portableapps.com/apps/office/libreoffice_portable before assuming
# this URL still resolves). SourceForge's /download suffix auto-redirects
# to a mirror, unlike PortableApps.com's own page which requires their
# platform app rather than serving a direct file link.
$libreOfficeVersion = "26.2.4"
$libreOfficeInstaller = "$binDir\LibreOfficePortable.paf.exe"
Invoke-WebRequest -Uri "https://sourceforge.net/projects/portableapps/files/LibreOffice%20Portable/LibreOfficePortable_${libreOfficeVersion}_Multilingual.paf.exe/download" -OutFile $libreOfficeInstaller
$libreOfficeDir = (Resolve-Path $binDir).Path + "\LibreOfficePortable"
Start-Process -FilePath $libreOfficeInstaller -ArgumentList "/S", "/D=$libreOfficeDir" -Wait
Remove-Item $libreOfficeInstaller -Force
Write-Host "LibreOffice Portable installed to: $libreOfficeDir"

Write-Host "All binaries downloaded successfully!"
