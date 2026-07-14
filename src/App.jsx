import Header from './components/Header.jsx'
import StatusBar from './components/StatusBar.jsx'
import { useTheme } from './hooks/useTheme.js'

// Phase 2.1: static shell only (Header/StatusBar/theme toggle). The main
// content area is a placeholder until Phase 2.2-2.5 port DropZone,
// SettingsPanel, ProgressBar, and the Trim modal — see
// design-system/MASTER.md's Phase 2 checkpoint for what "done" means here.
function App() {
  const { toggleTheme } = useTheme()

  return (
    <div className="app-shell">
      <Header fileType={null} onToggleTheme={toggleTheme} />
      <main className="main" id="main-content">
        <div className="flex h-full items-center justify-center text-text-secondary text-sm">
          Phase 2.1 shell scaffold — DropZone/SettingsPanel/ProgressBar/Trim land in later sub-phases.
        </div>
      </main>
      <StatusBar text="Ready" state="ready" />
    </div>
  )
}

export default App
