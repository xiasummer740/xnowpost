import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],
  root: path.resolve('src/renderer'),
  base: './',
  build: {
    outDir: path.resolve('dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
