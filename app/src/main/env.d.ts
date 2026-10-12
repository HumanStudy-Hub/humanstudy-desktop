/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** Server for dogfood builds (e.g. the dev preview); unset in public builds. */
  readonly MAIN_VITE_HUMANSTUDY_SERVER?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
