import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { engineCancel, enginePrompt, engineSetPrompted, engineStatus, installState, onInstallChange, startInstall } from '../plugin.js'
import { dict } from '../i18n/dict.js'
import { useTranslation } from '../hooks/useTranslation.js'

// First-run prompt: the first time the Converter opens with no Ghostscript
// found, offer the optional engines (engine_prompt / engine_set_prompted;
// recorded as soon as it shows, so it never comes back on its own). Plain
// .modal-content like Trim/Crop. Install uses the shared install state
// (plugin.js startInstall), so Settings shows the same progress; closing the
// prompt (or leaving the Converter) lets it carry on, and a notification
// reports the result instead.

// Module-level: an install started here outlives this component.
let promptOpen = false

const tNow = (key, params) => window.EstellaLib.i18n.translate(dict, window.EstellaLib.i18n.getLang(), key, params)

// The notification plugin's window.Notification (no JS import needed).
async function notify(title, body) {
  try {
    const N = window.Notification
    if (N.permission !== 'granted' && (await N.requestPermission()) !== 'granted') return
    new N(title, { body })
  } catch (e) {
    console.warn('notification failed', e)
  }
}

export default function EnginePrompt() {
  const { t } = useTranslation()
  const [engines, setEngines] = useState(null) // null = closed
  const [picked, setPicked] = useState({})
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const install = useSyncExternalStore(onInstallChange, installState)
  const contentRef = useRef(null)

  useEffect(() => {
    let live = true
    enginePrompt()
      .then(async (due) => {
        if (!due) return
        const list = await engineStatus()
        if (!live) return
        setEngines(list)
        setPicked(Object.fromEntries(list.map((e) => [e.id, e.installable])))
        promptOpen = true
        await engineSetPrompted(true)
      })
      .catch(console.error)
    return () => {
      live = false
      promptOpen = false
    }
  }, [])

  const close = () => {
    promptOpen = false
    setEngines(null)
  }

  useEffect(() => {
    if (!engines) return undefined
    contentRef.current?.querySelector('button:not([disabled])')?.focus()
    const onKey = (e) => e.key === 'Escape' && close()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [!!engines])

  if (!engines) return null

  const installSelected = async () => {
    setError('')
    for (const e of engines.filter((e) => e.installable && picked[e.id])) {
      const { list, error: err } = await startInstall(e.id)
      if (promptOpen) {
        setEngines(list)
        setError(err)
      } else if (err) {
        notify(tNow('enginePrompt.notifyTitle', { name: e.name }), tNow('enginePrompt.notifyFailed', { name: e.name, error: err }))
      } else if (list.find((x) => x.id === e.id)?.installed) {
        notify(tNow('enginePrompt.notifyTitle', { name: e.name }), tNow('enginePrompt.notifyDone', { name: e.name }))
      }
    }
    setDone(true)
  }

  const busy = install.percent !== null
  const offered = engines.filter((e) => e.installable && !e.installed)
  const anyPicked = offered.some((e) => picked[e.id])

  return (
    <div className="modal-overlay" id="engine-prompt">
      <div className="modal-content engine-prompt-content" ref={contentRef} role="dialog" aria-modal="true" aria-labelledby="engine-prompt-title" tabIndex={-1}>
        <div className="modal-header">
          <h3 className="modal-title" id="engine-prompt-title">{t('enginePrompt.title')}</h3>
        </div>
        <div className="modal-body">
          <p className="settings-hint">{t('enginePrompt.intro')}</p>
          {engines.map((e) => (
            <label key={e.id} className="engine-card" data-id={e.id} data-state={e.state}>
              {e.installable && !e.installed && (
                <input type="checkbox" checked={!!picked[e.id]} disabled={busy || done} onChange={(ev) => setPicked((p) => ({ ...p, [e.id]: ev.target.checked }))} />
              )}
              <div className="engine-card-body">
                <div className="engine-head">
                  <span className="engine-name">{e.name}</span>
                  {e.state !== 'missing' && <span className="engine-state">{t('enginePrompt.ready')}</span>}
                </div>
                <p className="settings-hint">{t(`enginePrompt.desc.${e.id}`)}</p>
                <p className="settings-hint">
                  {e.downloadSize && <>{t('enginePrompt.size', { mb: Math.round(e.downloadSize / 1e6) })} · </>}
                  {t('enginePrompt.license', { license: e.license })}
                </p>
                {e.installCommand && <p className="settings-hint">{t('enginePrompt.installWith')} <code>{e.installCommand}</code></p>}
                {install.engine === e.id && (
                  <div className="engine-progress">
                    <progress max="100" value={install.percent} />
                    <span className="settings-hint">{t('enginePrompt.downloading', { percent: Math.round(install.percent) })}</span>
                  </div>
                )}
              </div>
            </label>
          ))}
          {busy && <p className="settings-hint">{t('enginePrompt.background')}</p>}
          {error && <p className="settings-hint preset-error" role="alert">{error}</p>}
        </div>
        <div className="modal-footer" style={{ justifyContent: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {busy ? (
              <>
                <button type="button" className="btn btn-outline" id="btn-engine-prompt-cancel" onClick={() => engineCancel()}>{t('enginePrompt.cancel')}</button>
                <button type="button" className="btn btn-primary" id="btn-engine-prompt-close" onClick={close}>{t('enginePrompt.close')}</button>
              </>
            ) : done || !offered.length ? (
              <button type="button" className="btn btn-primary" id={done ? 'btn-engine-prompt-close' : 'btn-engine-prompt-skip'} onClick={close}>{t(done ? 'enginePrompt.close' : 'enginePrompt.skip')}</button>
            ) : (
              <>
                <button type="button" className="btn btn-outline" id="btn-engine-prompt-skip" onClick={close}>{t('enginePrompt.skip')}</button>
                <button type="button" className="btn btn-primary" id="btn-engine-prompt-install" disabled={!anyPicked} onClick={installSelected}>{t('enginePrompt.install')}</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
