import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// Self-contained Vite app for the "da-document-generator" tool — the generic
// spreadsheet/JSON -> {{token}} -> DA document generator. Builds into
// da-document-generator/dist/ and is served by AEM Edge Delivery at that subfolder path.
//
// Built entry:  da-document-generator/dist/index.html  ->  /da-document-generator/dist/index.html
// da.live app:  https://da.live/app/adobecom/da-tools/da-document-generator/dist/index
export default defineConfig(({ command }) => {
  const base = command === 'serve' ? '/' : '/da-document-generator/dist/'

  return {
    plugins: [react(), tailwindcss()],
    base,
    build: {
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name].[ext]',
        },
      },
    },
    server: {
      port: 3000,
    },
  }
})
