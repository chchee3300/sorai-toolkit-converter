// Phase 1 scaffold placeholder — proves the Vite + React + Tailwind pipeline
// and the ported design tokens work end-to-end. Real components (DropZone,
// SettingsPanel, etc., wired to resources/js/lib/*.js) land in Phase 2 per
// design-system/MASTER.md. Do not build real UI here yet.
function App() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg text-text-primary">
      <div className="rounded-glass border border-glass-border bg-glass-bg px-8 py-6 text-center">
        <h1 className="text-lg font-semibold">Estella Converter</h1>
        <p className="mt-2 text-sm text-text-secondary">
          Phase 1 scaffold: Vite + React + Tailwind pipeline verification.
          Real components land in Phase 2.
        </p>
      </div>
    </div>
  )
}

export default App
