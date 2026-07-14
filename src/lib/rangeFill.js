// Computes the --range-fill CSS custom property .range-input's CSS reads
// (resources/styles.css) to paint the accent-colored "filled" portion of a
// slider track up to the current value, at rest — not just on hover/drag.
export function rangeFillStyle(value, min, max) {
  const pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0
  return { '--range-fill': `${pct}%` }
}
