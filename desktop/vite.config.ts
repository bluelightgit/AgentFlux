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
  // node:fs 和 node:path 在 Electron 渲染进程中通过 preload 提供
  // Vite 需要将其标记为 external，不要打包
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
