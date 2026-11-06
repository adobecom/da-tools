import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// Self-contained Vite app for the "da-document-manager" tool (scaffold). Builds into
// da-document-manager/dist/ and is served by AEM Edge Delivery at that subfolder path.
//
// Built entry:  da-document-manager/dist/index.html  ->  /da-document-manager/dist/index.html
// da.live app:  https://da.live/app/adobecom/da-tools/da-document-manager/dist/index
export default defineConfig(({ command }) => {
  const base = command === 'serve' ? '/' : '/da-document-manager/dist/'

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
