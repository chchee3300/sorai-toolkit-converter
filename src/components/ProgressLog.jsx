import { useEffect, useRef } from 'react'

// Extracted from SettingsPanel.jsx (was nested inside #settings-section,
// after the execute-row) and relocated under the file-list module — same
// #progress-wrapper/#terminal-log ids and .progress-block/.terminal
// classes, unchanged, just a different parent in the tree.
function TerminalLog({ text }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])
  return (
    <div id="terminal-log" className="terminal" ref={ref}>
      {text}
    </div>
  )
}

export default function ProgressLog({ visible, percent, text, log }) {
  return (
    <div id="progress-wrapper" className={visible ? 'progress-block' : 'progress-block hidden'}>
      <div className="progress-track" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-bar" id="progress-bar" style={{ width: `${percent}%` }}></div>
      </div>
      <p className="progress-label tabular-nums" id="progress-text" role="status" aria-live="polite">{text}</p>
      <TerminalLog text={log} />
    </div>
  )
}
