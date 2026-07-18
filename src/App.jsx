import { useCallback, useEffect, useRef, useState } from 'react'
import StatusBar from './components/StatusBar.jsx'
import DropZone from './components/DropZone.jsx'
import FileList from './components/FileList.jsx'
import SettingsPanel from './components/SettingsPanel.jsx'
import ToolIntro from './components/ToolIntro.jsx'
import ProgressLog from './components/ProgressLog.jsx'
import MixedTypeModal from './components/MixedTypeModal.jsx'
import TrimModal from './components/TrimModal.jsx'
import CropModal from './components/CropModal.jsx'
import { useFileManager } from './hooks/useFileManager.js'
import { useSettings } from './hooks/useSettings.js'
import { useExecute } from './hooks/useExecute.js'
import { useTranslation } from './hooks/useTranslation.js'

// Ported from resources/index.html:42-46 (loading overlay markup).
function LoadingOverlay({ visible }) {
  const { t } = useTranslation()
  return (
    <div id="file-loading-overlay" className={visible ? 'loading-overlay' : 'loading-overlay hidden'} role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true"></div>
      <p>{t('app.readingFiles')}</p>
    </div>
  )
}

// This is the Converter tool's own content -- no <Header>, no useTheme()/
// useUpdateChecker() here. Those became shell/hub-level concerns during
// the multi-repo restructure (see the sorai-toolkit hub repo's App.jsx):
// the hub renders a persistent header (with a hamburger menu covering
// navigation + theme toggle) around whichever tool is active, and self-
// update-checking is a shell-level concern, not per-tool. When this repo
// is consumed as a library by the hub (src/index.js), `App` is exported
// as `ConverterApp` and rendered inside the hub's own layout. Standalone
// (`neu run` in this repo directly, via src/main.jsx) it's the same
// component with no surrounding chrome -- fine for isolated dev/testing of
// conversion behavior, which is what this dev harness is for.
// pendingLaunch (hub-provided, see sorai-toolkit's useSingleInstance.js):
// { seq, files, format, quickAction } | null -- an Explorer/Finder/Files
// right-click launch, either from this process's own cold start or
// forwarded from a second instance while this one was already running.
// A single seq-keyed object rather than separate initialFiles/
// initialFormat/initialQuickAction props: arrays have no stable
// reference equality, so "already open, a second launch just got
// forwarded in" needs something that reliably changes to re-trigger off
// of -- seq is that.
function App({ pendingLaunch }) {
  const { t } = useTranslation()
  const settings = useSettings()

  // Consumed by handleFirstFileType below, at the exact point
  // useFileManager already calls back into useSettings for its own
  // extension-derived default -- overriding that default (or diverting
  // into quick-compress) rather than duplicating loadFiles' "first file
  // in a fresh queue" logic here.
  const pendingFormatRef = useRef(null)
  const pendingQuickActionRef = useRef(null)
  const lastLaunchSeqRef = useRef(0)

  const handleFirstFileType = useCallback((type, ext) => {
    const quickAction = pendingQuickActionRef.current
    if (quickAction && type === 'video' && quickAction.type === 'compress-under') {
      settings.setVideo((v) => ({ ...v, targetSizeMode: true, targetSizeMB: quickAction.targetMB }))
      pendingQuickActionRef.current = null
      pendingFormatRef.current = null
      return
    }
    if (quickAction && type === 'pdf' && quickAction.type === 'compress-pdf') {
      settings.setPdf((v) => ({ ...v, optimize: 'compress' }))
      pendingQuickActionRef.current = null
      pendingFormatRef.current = null
      return
    }
    if (pendingFormatRef.current) {
      settings.setFormatForType(type, pendingFormatRef.current)
      pendingFormatRef.current = null
      return
    }
    settings.setFormatForType(type, ext)
  }, [settings])

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
    pendingMismatch,
    confirmClearAndLoad,
    cancelPendingMismatch,
  } = useFileManager({ onFirstFileType: handleFirstFileType })

  // Same seq -> re-trigger reasoning as the prop comment above. Naturally
  // routes through the existing pendingMismatch/MixedTypeModal confirm
  // flow via handleFiles when the queue already holds a different file
  // type -- the refs above just sit unconsumed until the user confirms.
  useEffect(() => {
    if (!pendingLaunch || pendingLaunch.seq === lastLaunchSeqRef.current) return
    lastLaunchSeqRef.current = pendingLaunch.seq
    if (pendingLaunch.format) pendingFormatRef.current = pendingLaunch.format
    if (pendingLaunch.quickAction) pendingQuickActionRef.current = pendingLaunch.quickAction
    handleFiles(pendingLaunch.files)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLaunch])

  const {
    execute,
    executing,
    cancel,
    cancelling,
    progressVisible,
    progressPercent,
    progressText,
    terminalLog,
  } = useExecute({ files, setFiles, fileType, settings, outputPath, setOutputPath, setStatus })

  const hasFiles = files.length > 0

  // A converted file's estimate is hidden in favor of the real result
  // (estimateDisplay.js's computeEstimate short-circuits on
  // fileObj.converted) — but that result only reflects the settings used
  // for that run. Without this, tweaking settings after a conversion to
  // set up a different reconvert left the size preview frozen on the old
  // actual result with no live feedback for the new settings. Any settings
  // change clears `converted` on files that have it, so FileList falls
  // back to a live estimate for whatever's now selected.
  useEffect(() => {
    setFiles((prev) => (prev.some((f) => f.converted) ? prev.map((f) => (f.converted ? { ...f, converted: false, convertedSizeMB: undefined } : f)) : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.video, settings.image, settings.audio, settings.pdf])

  // Ported from main.js's currentTrimIndex + openTrimModal/btn-save-trim
  // (main.js:539,595-598,854-867 pre-extraction).
  const [trimIndex, setTrimIndex] = useState(-1)
  const trimFile = trimIndex >= 0 ? files[trimIndex] : null

  const handleSaveTrim = (start, end) => {
    if (trimIndex < 0) return
    setFiles((prev) => prev.map((f, i) => (i === trimIndex ? { ...f, trimStart: start, trimEnd: end } : f)))
  }

  // Mirrors trimIndex/trimFile/handleSaveTrim above — crop is per-file state
  // stored the same way trim is, not a shared useSettings field.
  const [cropIndex, setCropIndex] = useState(-1)
  const cropFile = cropIndex >= 0 ? files[cropIndex] : null

  const handleSaveCrop = (crop) => {
    if (cropIndex < 0) return
    setFiles((prev) => prev.map((f, i) => (i === cropIndex ? { ...f, crop } : f)))
  }

  return (
    <>
      <main className="main" id="main-content">
        <LoadingOverlay visible={loading} />

        <div className="main-columns">
          <section className="panel panel--ghost" id="input-panel">
            {!hasFiles && <DropZone onClick={browseForFiles} />}
            <div id="file-list-container" className={hasFiles ? '' : 'hidden'}>
              <div className="filelist-header">
                <span className="mono-label tabular-nums" id="file-count-label">
                  {t('app.fileCount', { count: files.length, type: fileType ? t(`fileType.${fileType}`) : '' })}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost-success btn-xs" id="btn-add-files" onClick={browseForFiles}>
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                      <line x1="8" y1="3" x2="8" y2="13" />
                      <line x1="3" y1="8" x2="13" y2="8" />
                    </svg>
                    {t('app.addFiles')}
                  </button>
                  <button className="btn btn-ghost btn-xs" id="btn-clear-files" onClick={clearFiles}>
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                      <line x1="3" y1="3" x2="13" y2="13" />
                      <line x1="13" y1="3" x2="3" y2="13" />
                    </svg>
                    {t('app.clearAll')}
                  </button>
                </div>
              </div>
              <FileList files={files} fileType={fileType} settings={settings} onRemove={removeFile} onOpenTrim={setTrimIndex} onOpenCrop={setCropIndex} />
            </div>
            <ProgressLog visible={progressVisible} percent={progressPercent} text={progressText} log={terminalLog} />
          </section>

          {hasFiles ? (
            <SettingsPanel
              files={files}
              fileType={fileType}
              settings={settings}
              outputPath={outputPath}
              onBrowseOutput={browseForOutputFolder}
              executing={executing}
              cancelling={cancelling}
              onExecute={execute}
              onCancel={cancel}
            />
          ) : (
            <ToolIntro />
          )}
        </div>
      </main>
      {/* status carries a dict key + params (see useFileManager's setStatus),
          translated here at render so the always-on status bar re-renders in
          the new language immediately on a switch. */}
      <StatusBar text={t(status.key, status.params)} state={status.state} />
      <TrimModal
        open={trimIndex >= 0}
        file={trimFile}
        fileType={fileType}
        onClose={() => setTrimIndex(-1)}
        onSave={handleSaveTrim}
      />
      <CropModal
        open={cropIndex >= 0}
        file={cropFile}
        onClose={() => setCropIndex(-1)}
        onSave={handleSaveCrop}
      />
      <MixedTypeModal
        open={!!pendingMismatch}
        existingType={pendingMismatch?.existingType}
        incomingType={pendingMismatch?.incomingType}
        existingCount={pendingMismatch?.existingCount ?? 0}
        incomingCount={pendingMismatch?.paths.length ?? 0}
        onConfirm={confirmClearAndLoad}
        onCancel={cancelPendingMismatch}
      />
    </>
  )
}

export default App
