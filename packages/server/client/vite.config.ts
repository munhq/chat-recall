import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  define: {
    // Visible build identity — settles "which build is my tab running"
    // with a glance instead of an argument.
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
  },
  plugins: [react()],
  server: {
    host: '0.0.0.0', // Listen on all network interfaces
    port: Number(process.env.VITE_DEV_PORT) || 5174,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});
