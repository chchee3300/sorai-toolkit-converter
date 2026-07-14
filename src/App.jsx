import { useState } from 'react'
import Header from './components/Header.jsx'
import StatusBar from './components/StatusBar.jsx'
import DropZone from './components/DropZone.jsx'
import FileList from './components/FileList.jsx'
import SettingsPanel from './components/SettingsPanel.jsx'
import TrimModal from './components/TrimModal.jsx'
import { useTheme } from './hooks/useTheme.js'
import { useFileManager } from './hooks/useFileManager.js'
import { useSettings } from './hooks/useSettings.js'
import { useExecute } from './hooks/useExecute.js'

// Ported from resources/index.html:42-46 (loading overlay markup).
function LoadingOverlay({ visible }) {
  return (
    <div id="file-loading-overlay" className={visible ? 'loading-overlay' : 'loading-overlay hidden'}>
      <div className="spinner"></div>
      <p>Reading files…</p>
    </div>
  )
}

function App() {
  const { toggleTheme } = useTheme()
  const settings = useSettings()

  const {
    files,
    setFiles,
    fileType,
    outputPath,
    setOutputPath,
    loading,
    status,
    setStatus,
    handleFiles,
    removeFile,
    clearFiles,
    browseForFiles,
    browseForOutputFolder,
  } = useFileManager({ onFirstFileType: settings.setFormatForType })

  const {
    execute,
    executing,
    progressVisible,
    progressPercent,
    progressText,
    terminalLog,
  } = useExecute({ files, setFiles, fileType, settings, outputPath, setOutputPath, setStatus })

  const hasFiles = files.length > 0

  // Ported from main.js's currentTrimIndex + openTrimModal/btn-save-trim
  // (main.js:539,595-598,854-867 pre-extraction).
  const [trimIndex, setTrimIndex] = useState(-1)
  const trimFile = trimIndex >= 0 ? files[trimIndex] : null

  const handleSaveTrim = (start, end) => {
    if (trimIndex < 0) return
    setFiles((prev) => prev.map((f, i) => (i === trimIndex ? { ...f, trimStart: start, trimEnd: end } : f)))
  }

  return (
    <div className="app-shell">
      <Header fileType={fileType} onToggleTheme={toggleTheme} />
      <main className="main" id="main-content">
        <LoadingOverlay visible={loading} />

        <section className="panel panel--ghost" id="input-panel">
          {!hasFiles && <DropZone onClick={browseForFiles} />}
          <div id="file-list-container" className={hasFiles ? '' : 'hidden'}>
            <div className="filelist-header">
              <span className="mono-label" id="file-count-label">
                {files.length} file{files.length !== 1 ? 's' : ''} · {fileType ? fileType.toUpperCase() : ''}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost-success btn-xs" id="btn-add-files" onClick={browseForFiles}>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="8" y1="3" x2="8" y2="13" />
                    <line x1="3" y1="8" x2="13" y2="8" />
                  </svg>
                  Add files
                </button>
                <button className="btn btn-ghost btn-xs" id="btn-clear-files" onClick={clearFiles}>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="3" y1="3" x2="13" y2="13" />
                    <line x1="13" y1="3" x2="3" y2="13" />
                  </svg>
                  Clear all
                </button>
              </div>
            </div>
            <FileList files={files} fileType={fileType} settings={settings} onRemove={removeFile} onOpenTrim={setTrimIndex} />
          </div>
        </section>

        <SettingsPanel
          files={files}
          fileType={fileType}
          settings={settings}
          outputPath={outputPath}
          onBrowseOutput={browseForOutputFolder}
          executing={executing}
          progressVisible={progressVisible}
          progressPercent={progressPercent}
          progressText={progressText}
          terminalLog={terminalLog}
          onExecute={execute}
        />
      </main>
      <StatusBar text={status.text} state={status.state} />
      <TrimModal
        open={trimIndex >= 0}
        file={trimFile}
        fileType={fileType}
        onClose={() => setTrimIndex(-1)}
        onSave={handleSaveTrim}
      />
    </div>
  )
}

export default App
