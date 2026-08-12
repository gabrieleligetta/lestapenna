import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In production, Caddy serves this build under /app/* and proxies /api,
// /health, /webhooks to the bot process — same origin, so cookies just work.
// In dev, Vite runs on its own port: proxy the same paths to the bot
// (default localhost:3000) so `npm run dev` behaves the same way without CORS.
const BACKEND_URL = process.env.VITE_BACKEND_URL || 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: BACKEND_URL, changeOrigin: true },
      '/health': { target: BACKEND_URL, changeOrigin: true },
      '/webhooks': { target: BACKEND_URL, changeOrigin: true },
    },
  },
  base: '/app/',
})
