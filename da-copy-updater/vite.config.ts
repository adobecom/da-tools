import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// Self-contained Vite app for the "da-copy-updater" tool. Builds into da-copy-updater/dist/ and is
// served by AEM Edge Delivery at that subfolder path.
//
// Built entry:  da-copy-updater/dist/index.html  ->  /da-copy-updater/dist/index.html
// da.live app:  https://da.live/app/adobecom/da-tools/da-copy-updater/dist/index
export default defineConfig(({ command }) => {
  const base = command === 'serve' ? '/' : '/da-copy-updater/dist/'

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
