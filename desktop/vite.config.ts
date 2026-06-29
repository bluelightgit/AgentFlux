import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Mark node builtins as external for BOTH dev and build.
  // In dev, Vite will skip resolving them (our code uses dynamic import
  // for node:fs so this is just a safety net).
  optimizeDeps: {
    exclude: ['node:fs', 'node:path', 'fs', 'path'],
  },
  build: {
    rollupOptions: {
      external: ['node:fs', 'node:path', 'fs', 'path'],
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'recharts-vendor': ['recharts'],
          'zustand-vendor': ['zustand'],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
})
