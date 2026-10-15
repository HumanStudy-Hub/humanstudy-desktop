import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './browser-api'
import App from './App'
import './styles.css'
import { installCapture } from './capture'

installCapture()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
