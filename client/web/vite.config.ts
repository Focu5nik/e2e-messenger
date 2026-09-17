import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL('.', import.meta.url))
  const env = loadEnv(mode, envDir, '')
  const frontendOrigin = new URL(env.FRONTEND_ORIGIN ?? 'http://localhost:5173')

  return {
    envDir,
    plugins: [react()],
    server: {
      host: frontendOrigin.hostname,
      port: Number(frontendOrigin.port || 5173),
      strictPort: true,
    },
  }
})
