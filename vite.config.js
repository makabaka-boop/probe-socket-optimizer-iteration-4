import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发环境通过 5173 访问，/api 代理到 Fastify(3000)；生产环境直接由 Fastify 托管静态文件
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{js,jsx}'],
    testTimeout: 20000,
  },
});
