import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  base: '/SignalForge/',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
});
