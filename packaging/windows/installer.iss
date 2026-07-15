; Inno Setup script for SORAI Toolkit (Windows installer).
; Compile with: iscc /DAppVersion=<version> packaging/windows/installer.iss
; (run from the repo root, or pass /O to redirect OutputDir if needed)
;
; Expects (already built by the caller):
;   dist/FileConverterApp/FileConverterApp-win_x64.exe  (neu build --release --embed-resources)
;   binaries/win_x64/*                                   (node setup.mjs)
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#define AppName "SORAI Toolkit"
; Fixed GUID so upgrades replace the previous install instead of
; side-by-side installing -- never change this once released.
#define AppId "{{6C6C6F2C-9E0E-4B0C-8A9B-2C8B7B6C4F1E}}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=SORAI Toolkit
AppPublisherURL=https://github.com/chchee3300/FileConverterApp
DefaultDirName={autopf}\SORAI Toolkit
DefaultGroupName=SORAI Toolkit
UninstallDisplayIcon={app}\sorai-toolkit.exe
OutputDir=..\..\release-assets
OutputBaseFilename=sorai-toolkit-setup-{#AppVersion}-win_x64
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
; Explicit (rather than relying on Inno Setup's defaults) so both the
; destination-folder and Start Menu wizard pages always show -- the latter
; also gives the user its built-in "Don't create a Start Menu folder"
; checkbox, rather than silently always creating one.
DisableDirPage=no
DisableProgramGroupPage=no
AllowNoIcons=yes
; Detects a running previous instance (by matching the exe being replaced)
; and offers to close it before install -- this is also what powers the
; in-app self-update flow's /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS flags
; (see useUpdateChecker.js).
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "..\..\dist\FileConverterApp\FileConverterApp-win_x64.exe"; DestDir: "{app}"; DestName: "sorai-toolkit.exe"; Flags: ignoreversion
Source: "..\..\binaries\win_x64\*"; DestDir: "{app}\binaries\win_x64"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\SORAI Toolkit"; Filename: "{app}\sorai-toolkit.exe"
Name: "{group}\Uninstall SORAI Toolkit"; Filename: "{uninstallexe}"
Name: "{autodesktop}\SORAI Toolkit"; Filename: "{app}\sorai-toolkit.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\sorai-toolkit.exe"; Description: "Launch SORAI Toolkit"; Flags: nowait postinstall skipifsilent
