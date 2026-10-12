/// <reference types="vite/client" />
import type { HumanStudyApi } from '../preload/types'

declare global {
  interface Window {
    humanstudy: HumanStudyApi
  }
}
