import { useEffect, useRef } from 'react'

// Wraps a native <select> with liquid-glass.js's LiquidSelect custom
// dropdown (resources/js/liquid-glass.js). React owns value/onChange
// declaratively as usual; LiquidSelect.sync() keeps the custom overlay's
// trigger text + highlighted option in step whenever value changes from
// outside a direct click on the dropdown itself (which already self-syncs
// via its own mousedown handler, liquid-glass.js:308-315). The disabled
// attribute is watched by LiquidSelect's own MutationObserver
// (liquid-glass.js:449-450), so no extra handling needed for that here.
export default function GlassSelect({ id, value, onChange, disabled, children }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !window.LiquidSelect) return
    window.LiquidSelect.create(el)
    return () => window.LiquidSelect.destroy(el)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (ref.current && window.LiquidSelect) window.LiquidSelect.sync(ref.current)
  }, [value])

  return (
    <select id={id} className="input" ref={ref} value={value} onChange={onChange} disabled={disabled}>
      {children}
    </select>
  )
}
