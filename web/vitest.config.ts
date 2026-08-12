import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Kept separate from vite.config.ts so the build config stays free of test
// concerns (and of a `/// <reference types="vitest" />` in a file that
// tsconfig.node.json typechecks).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // jsdom defaults to about:blank, an opaque origin, where the storage APIs are
    // simply absent — anything reading localStorage/sessionStorage (locale, theme,
    // the post-login return path) throws on mount. A real origin turns them on.
    environmentOptions: { jsdom: { url: 'http://localhost:5173/' } },
    setupFiles: ['./src/test/setup.ts'],
    // Globals stay off: test files live under src/ and so are already in the
    // `tsc -b` graph, where tsconfig.app.json's noUnusedLocals applies. Explicit
    // imports from 'vitest' keep that honest.
    globals: false,
    css: false,
  },
})
