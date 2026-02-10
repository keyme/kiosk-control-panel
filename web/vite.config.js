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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/cornerstone-core') || id.includes('node_modules/cornerstone-tools') || id.includes('node_modules/cornerstone-web-image-loader') || id.includes('node_modules/cornerstone-math') || id.includes('node_modules/hammerjs')) {
            return 'cornerstone';
          }
        },
      },
    },
  },
  server: {
    port: 8081,
    // Must match control_panel/config/ports.json "python" (2026).
    // Same-origin proxy avoids cross-site cookie rejection (io cookie, SameSite).
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:2026',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://127.0.0.1:2026',
        changeOrigin: true,
        ws: true,
        secure: false,
      },
    },
  },
});
