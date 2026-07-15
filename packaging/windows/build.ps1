# Zips the Windows release build for GitHub Release attachment.
# Run from the repo root: pwsh packaging/windows/build.ps1 -Version <version>
#
# Expects (already built by the caller):
#   dist/FileConverterApp/FileConverterApp-win_x64.exe  (neu build --release --embed-resources)
#   binaries/win_x64/*                                   (node setup.mjs)
param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)
$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path "$PSScriptRoot/../.."
$Exe = Join-Path $RepoRoot "dist/FileConverterApp/FileConverterApp-win_x64.exe"
$BinDir = Join-Path $RepoRoot "binaries/win_x64"
$OutDir = Join-Path $RepoRoot "release-assets"
$StageDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())

if (-not (Test-Path $Exe)) { throw "Missing $Exe -- run 'neu build --release --embed-resources' first" }
if (-not (Test-Path $BinDir)) { throw "Missing $BinDir -- run 'node setup.mjs' first" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path "$StageDir/binaries/win_x64" | Out-Null

Copy-Item $Exe "$StageDir/sorai-toolkit.exe"
Copy-Item "$BinDir/*" "$StageDir/binaries/win_x64/" -Recurse

$ZipPath = Join-Path $OutDir "sorai-toolkit-$Version-win_x64.zip"
Compress-Archive -Path "$StageDir/*" -DestinationPath $ZipPath -Force
Remove-Item -Recurse -Force $StageDir

Write-Host "Built $ZipPath"
