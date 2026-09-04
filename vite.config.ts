import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const packageVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

/**
 * Stamps the service worker cache name with the package version plus a hash of the built entry
 * document (which embeds every hashed asset name). The stamp is deterministic for identical builds,
 * so the tracked dist/ only changes when the deployed bundle actually changes.
 */
function serviceWorkerCacheVersion(): Plugin {
  const placeholder = '__SF_CACHE_VERSION__';
  let outDir = 'dist';
  return {
    name: 'signalforge-sw-cache-version',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // A CRLF checkout (core.autocrlf on Windows) would otherwise leak into the tracked dist/index.html
        // as mixed line endings and change the cache stamp for an identical build.
        return html.replace(/\r\n?/g, '\n');
      }
    },
    closeBundle() {
      const swPath = path.join(outDir, 'sw.js');
      const indexPath = path.join(outDir, 'index.html');
      const digest = createHash('sha256').update(readFileSync(indexPath)).digest('hex').slice(0, 12);
      const source = readFileSync(swPath, 'utf8');
      if (!source.includes(placeholder)) {
        throw new Error(`public/sw.js no longer contains the ${placeholder} cache-name placeholder.`);
      }
      writeFileSync(swPath, source.replaceAll(placeholder, `${packageVersion}-${digest}`));
    }
  };
}

export default defineConfig({
  plugins: [tailwindcss(), serviceWorkerCacheVersion()],
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
