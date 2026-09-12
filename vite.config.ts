import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    projects: [
      { extends: true, test: { name: 'node', environment: 'node', include: ['tests/*.test.ts'] } },
      { extends: true, test: { name: 'dom', environment: 'jsdom', include: ['tests/dom/**/*.test.{ts,tsx}'] } },
    ],
  },
});
