import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    https: true,       // ativa https
    host: true,        // 0.0.0.0 (expor na rede)
    port: 5173,
    strictPort: true
  },
  // para GitHub Pages:
  // base: '/ProjetoBIM/'
})
