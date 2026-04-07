import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'app',
  publicDir: '../public',
  build: {
    outDir: '../dist-app',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
  },
});
