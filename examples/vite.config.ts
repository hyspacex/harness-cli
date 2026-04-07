import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createQuizMiddleware } from './src/quiz/server.js';
import { createTutorMiddleware } from './src/tutor/server.js';

export default defineConfig({
  plugins: [
    {
      name: 'aws-study-api',
      configureServer(server) {
        server.middlewares.use(createTutorMiddleware());
        server.middlewares.use(createQuizMiddleware());
      },
    },
    react(),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.ts',
  },
});
