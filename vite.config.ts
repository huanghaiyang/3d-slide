import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'copy-docs',
      apply: 'build',
      closeBundle() {
        cpSync(resolve(root, 'docs'), resolve(root, 'dist/docs'), { recursive: true });
      },
    },
  ],
  server: {
    port: 5176,
  },
});
