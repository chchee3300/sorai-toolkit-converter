import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// liquid-glass.js explicitly assigns window.LiquidSelect/window.initLiquidGlass
// (liquid-glass.js:495-496), so it's safe to bundle as a normal side-effect
// ES import. neutralino.js is NOT imported here — it's loaded via a real
// <script src> in index.html instead, see the comment there for why.
import '../resources/js/liquid-glass.js'

// Strangler-fig lib modules (Phase 0.4) — each attaches to
// window.EstellaLib.* explicitly, same reasoning as liquid-glass.js.
import '../resources/js/lib/filename-collision.js'
import '../resources/js/lib/ffmpeg-commands.js'
import '../resources/js/lib/qpdf-commands.js'
import '../resources/js/lib/progress-parser.js'
import '../resources/js/lib/size-estimate.js'

// Neutralino.init() only functions when this app is actually served by a
// running `neu` process (window.NL_PORT/NL_TOKEN injected by neu's dev
// server into its response for the <script src> above); in a plain Vite
// dev/preview session (no neu process) window.Neutralino still won't exist
// at all, which is expected — see design-system/MASTER.md Phase 2.6 for
// when this becomes fully testable end-to-end.
if (window.Neutralino) {
  window.Neutralino.init()
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
