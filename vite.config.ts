import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const packageVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

function sourceBuildId(): string {
  const digest = createHash('sha256');
  const textExtensions = new Set(['.css', '.html', '.js', '.json', '.mjs', '.ts', '.tsx', '.txt']);
  const visit = (entryPath: string): void => {
    const status = statSync(entryPath);
    if (status.isDirectory()) {
      for (const child of readdirSync(entryPath).sort()) visit(path.join(entryPath, child));
      return;
    }
    digest.update(entryPath.replaceAll('\\', '/'));
    const content = readFileSync(entryPath);
    digest.update(
      textExtensions.has(path.extname(entryPath).toLowerCase())
        ? content.toString('utf8').replace(/\r\n?/g, '\n')
        : content
    );
  };
  ['index.html', 'package.json', 'src', 'public', 'vite.config.ts'].forEach(visit);
  return digest.digest('hex').slice(0, 12);
}

const buildId = sourceBuildId();

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function writeLf(filePath: string, text: string): void {
  writeFileSync(filePath, normalizeNewlines(text));
}

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
      order: 'pre',
      handler(html) {
        // Vite's HTML transform is not byte-identical for CRLF vs LF source. Windows checkouts with
        // core.autocrlf=true would otherwise emit an extra blank line in dist/index.html and a
        // different service-worker cache stamp than GitHub's Ubuntu runner.
        return normalizeNewlines(html);
      }
    },
    closeBundle() {
      const swPath = path.join(outDir, 'sw.js');
      const indexPath = path.join(outDir, 'index.html');
      writeLf(indexPath, readFileSync(indexPath, 'utf8'));
      const digest = createHash('sha256').update(readFileSync(indexPath)).digest('hex').slice(0, 12);
      const source = readFileSync(swPath, 'utf8');
      if (!source.includes(placeholder)) {
        throw new Error(`public/sw.js no longer contains the ${placeholder} cache-name placeholder.`);
      }
      writeLf(swPath, source.replaceAll(placeholder, `${packageVersion}-${digest}`));
    }
  };
}

export default defineConfig({
  plugins: [tailwindcss(), serviceWorkerCacheVersion()],
  define: {
    __APP_VERSION__: JSON.stringify(packageVersion),
    __BUILD_ID__: JSON.stringify(buildId)
  },
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
