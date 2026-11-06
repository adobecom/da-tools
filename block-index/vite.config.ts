import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// Self-contained Vite app for the "block-index" tool — indexes every block in use across any
// adobecom DA repo. Builds into block-index/dist/ and is served by AEM Edge Delivery at that
// subfolder path.
//
// Built entry:  block-index/dist/index.html  ->  /block-index/dist/index.html
// da.live app:  https://da.live/app/adobecom/da-tools/block-index/dist/index
export default defineConfig(({ command }) => {
  const base = command === 'serve' ? '/' : '/block-index/dist/'

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
