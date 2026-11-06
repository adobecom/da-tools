import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// Self-contained Vite app for the "block-manager" tool — a two-pane block/variant workspace,
// cloned from block-index. Builds into block-manager/dist/ and is served by AEM Edge Delivery at
// that subfolder path.
//
// Built entry:  block-manager/dist/index.html  ->  /block-manager/dist/index.html
// da.live app:  https://da.live/app/adobecom/da-tools/block-manager/dist/index
export default defineConfig(({ command }) => {
  const base = command === 'serve' ? '/' : '/block-manager/dist/'

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
