import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Runs in a utilityProcess, so it is its own bundle next to the main one.
          'vad-worker': resolve(__dirname, 'src/inference/vad/vad-worker.ts'),
          'wake-worker': resolve(__dirname, 'src/inference/wake-word/wake-worker.ts')
        }
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: false,
      isolatedEntries: true,
      rollupOptions: {
        input: {
          ui: resolve(__dirname, 'src/preload/ui.ts'),
          media: resolve(__dirname, 'src/preload/media.ts'),
          overlay: resolve(__dirname, 'src/preload/overlay.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    // The hand landmarker worker is an ES module so it can load the engine's module build.
    worker: { format: 'es' },
    build: {
      rollupOptions: {
        input: {
          ui: resolve(__dirname, 'src/renderer/ui/index.html'),
          media: resolve(__dirname, 'src/renderer/media/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html')
        }
      }
    }
  }
})
