# Downloads and silently installs Inno Setup (used to build the Windows
# installer -- see packaging/windows/build.ps1). Idempotent: skips the
# download if already installed.
$ErrorActionPreference = "Stop"

$IsccPaths = @(
    "$env:ProgramFiles\Inno Setup 7\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe"
)
if ($IsccPaths | Where-Object { Test-Path $_ }) {
    Write-Host "Inno Setup already installed."
    exit 0
}

$Url = "https://github.com/jrsoftware/issrc/releases/download/is-7_0_2/innosetup-7.0.2-x64.exe"
$Installer = Join-Path ([System.IO.Path]::GetTempPath()) "innosetup-installer.exe"

Write-Host "Downloading Inno Setup..."
Invoke-WebRequest -Uri $Url -OutFile $Installer

Write-Host "Installing Inno Setup..."
Start-Process -FilePath $Installer -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/ALLUSERS" -Wait
Remove-Item $Installer -Force

Write-Host "Inno Setup installed."
