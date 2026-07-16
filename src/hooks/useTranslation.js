import { useSyncExternalStore } from 'react'
import { dict } from '../i18n/dict.js'

// Thin wrapper around window.EstellaLib.i18n (resources/js/lib/i18n.js) --
// see that file's own header comment for why the language *mechanism* is a
// shared cross-package runtime global while the translation *content* below
// is this package's own. useSyncExternalStore (not useState+useEffect) is
// what makes every component calling this actually re-render when the
// language changes, since the source of truth lives outside React entirely.
export function useTranslation() {
  const lang = useSyncExternalStore(
    (cb) => window.EstellaLib.i18n.subscribe(cb),
    () => window.EstellaLib.i18n.getLang(),
  )
  const t = (key, params) => window.EstellaLib.i18n.translate(dict, lang, key, params)
  return { t, lang }
}
