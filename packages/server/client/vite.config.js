import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
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
