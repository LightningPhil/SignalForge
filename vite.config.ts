import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  base: '/SignalForge/',
  worker: {
    format: 'es'
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(moduleId) {
          if (moduleId.includes('node_modules/plotly')) return 'plotly';
          if (moduleId.includes('node_modules/mathjs')) return 'math';
          if (moduleId.includes('node_modules/papaparse')) return 'csv';
          if (moduleId.includes('node_modules/fflate')) return 'archive';
          return undefined;
        }
      }
    }
  }
});
