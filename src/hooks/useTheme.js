import { useCallback, useEffect, useState } from 'react'

// Ported unchanged from resources/js/main.js's theme-toggle IIFE
// (main.js:521-536): same localStorage key, same data-theme attribute
// target, same dark<->light toggle behavior.
const STORAGE_KEY = 'estella-theme'

export function useTheme() {
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute('data-theme') || 'dark',
  )

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }, [])

  return { theme, toggleTheme }
}
