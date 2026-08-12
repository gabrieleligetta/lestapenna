import { StrictMode, useState } from 'react'
import { createRoot, type Root as ReactRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider, keepPreviousData } from '@tanstack/react-query'
import '@fontsource-variable/manrope'
import '@fontsource-variable/newsreader'
import './index.css'
import App from './App.tsx'
import { LocaleContext, detectLocale, type Locale } from './i18n'
import { ThemeProvider } from './context/ThemeProvider'
import { applyTheme, detectThemePreference } from './theme'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      // Without this the table blanks to a spinner on every keystroke of a
      // search and on every page step; with it the previous rows stay put
      // until the new ones arrive.
      placeholderData: keepPreviousData,
    },
  },
})

// Before the first paint, so the page never flashes light chrome on a dark theme.
applyTheme(detectThemePreference())

function Root() {
  const [locale, setLocale] = useState<Locale>(detectLocale())

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          {/* Caddy strips /app only for disk lookups; the browser URL keeps the
              prefix, so the router needs it too. BASE_URL is Vite's base ('/app/'),
              which keeps this in sync with vite.config.ts. */}
          <BrowserRouter basename={import.meta.env.BASE_URL}>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </LocaleContext.Provider>
  )
}

interface LestapennaGlobal extends Window {
  __LESTAPENNA_REACT_ROOT__?: ReactRoot
}

const globalScope = window as LestapennaGlobal
const root = globalScope.__LESTAPENNA_REACT_ROOT__
  ?? createRoot(document.getElementById('root')!)

globalScope.__LESTAPENNA_REACT_ROOT__ = root

root.render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
