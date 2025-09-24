import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl' // ok deixar no dev

export default defineConfig({
  plugins: [basicSsl()],
  server: { https: true, host: true, port: 5173, strictPort: true },
  base: '/ProjetoBIM/'           // nome do repositório
})
