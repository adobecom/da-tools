import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// Self-contained Vite app for the "da-document-studio" tool — a combined DA document
// generator + document manager behind a two-tab shell. Builds into da-document-studio/dist/
// and is served by AEM Edge Delivery at that subfolder path.
//
// Built entry:  da-document-studio/dist/index.html  ->  /da-document-studio/dist/index.html
// da.live app:  https://da.live/app/adobecom/da-tools/da-document-studio/dist/index
export default defineConfig(({ command }) => {
  const base = command === 'serve' ? '/' : '/da-document-studio/dist/'

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
