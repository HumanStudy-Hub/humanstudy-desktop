// A tiny i18n layer: t(key, vars) over two dictionaries, no library. The language is a renderer
// preference (System / English / 中文) kept in localStorage; "System" follows navigator.language.
import { useSyncExternalStore } from 'react'
import { EN, ZH } from './i18n-dict'

export type Lang = 'en' | 'zh-CN'
export type LangPref = 'system' | Lang

const KEY = 'hs.lang'

/** The language a preference resolves to; `navLang` is navigator.language. */
export function resolveLang(pref: LangPref, navLang: string | undefined): Lang {
  if (pref === 'en' || pref === 'zh-CN') return pref
  return (navLang ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

/** Replace {name} placeholders. */
export function format(template: string, vars?: Record<string, string | number>): string {
  return vars ? template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : template
}

/** Look a key up in a language, falling back to English, then to the key itself. */
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const dict = lang === 'zh-CN' ? ZH : EN
  return format(dict[key] ?? EN[key] ?? key, vars)
}

function readPref(): LangPref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'en' || v === 'zh-CN' || v === 'system') return v
  } catch {
    /* no storage */
  }
  return 'system'
}

let pref: LangPref = readPref()
let lang: Lang = resolveLang(pref, typeof navigator === 'undefined' ? undefined : navigator.language)
const listeners = new Set<() => void>()

export const getLangPref = (): LangPref => pref
export const getLang = (): Lang => lang

export function setLangPref(next: LangPref): void {
  pref = next
  lang = resolveLang(next, typeof navigator === 'undefined' ? undefined : navigator.language)
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = lang
  listeners.forEach((cb) => cb())
}
if (typeof document !== 'undefined') document.documentElement.lang = lang

/** The current-language string for a key. Components that call it re-render when the language changes
 *  because App subscribes with useLang(). */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(lang, key, vars)
}

/** Subscribe to language changes (App uses it so the whole tree re-renders). */
export function useLang(): { lang: Lang; pref: LangPref } {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => lang + pref,
  )
  return { lang, pref }
}

/** zh-CN translation when the key exists, else `fallback` (for data-driven labels such as sections.ts,
 *  whose English text lives in the data itself). */
export function tOr(key: string, fallback: string): string {
  return lang === 'zh-CN' ? (ZH[key] ?? fallback) : fallback
}
