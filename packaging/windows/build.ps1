# Compiles the Windows installer (Inno Setup) for GitHub Release attachment.
# Run from the repo root: pwsh packaging/windows/build.ps1 -Version <version>
#
# Expects (already built by the caller):
#   dist/FileConverterApp/FileConverterApp-win_x64.exe  (neu build --release --embed-resources)
#   binaries/win_x64/*                                   (node setup.mjs)
#   Inno Setup installed (packaging/windows/install-innosetup.ps1, or already
#   present locally -- see README's Setup section)
param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)
$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path "$PSScriptRoot/../.."
$Exe = Join-Path $RepoRoot "dist/FileConverterApp/FileConverterApp-win_x64.exe"
$BinDir = Join-Path $RepoRoot "binaries/win_x64"
$OutDir = Join-Path $RepoRoot "release-assets"

if (-not (Test-Path $Exe)) { throw "Missing $Exe -- run 'neu build --release --embed-resources' first" }
if (-not (Test-Path $BinDir)) { throw "Missing $BinDir -- run 'node setup.mjs' first" }

$Iscc = @(
    "$env:ProgramFiles\Inno Setup 7\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $Iscc) { throw "ISCC.exe not found -- run packaging/windows/install-innosetup.ps1 first" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

& $Iscc "/DAppVersion=$Version" (Join-Path $RepoRoot "packaging/windows/installer.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC compile failed with exit code $LASTEXITCODE" }

Write-Host "Built $OutDir\sorai-toolkit-setup-$Version-win_x64.exe"
