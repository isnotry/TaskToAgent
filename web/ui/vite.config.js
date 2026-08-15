import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 构建产物输出到 web/dist，由 web/server.js 托管（与 CLI 共用同一 SQLite）
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
  },
});
