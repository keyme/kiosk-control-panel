import path from 'path';
import { fileURLToPath } from 'url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  root: '.',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 800,
    rollupOptions: {},
  },
  server: {
    port: 8081,
    // Must match control_panel/config/ports.json "python" (2026).
    // WebSocket proxy for device control panel (path /ws).
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:2026',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://127.0.0.1:2026',
        changeOrigin: true,
        ws: true,
        secure: false,
      },
    },
  },
});
