import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const version = (JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { version: string }).version;

describe('service worker cache versioning', () => {
  it('keeps the build-time placeholder in the source worker and never a hard-coded cache name', () => {
    const source = readFileSync(path.resolve('public/sw.js'), 'utf8');
    expect(source).toContain("const CACHE_NAME = 'signalforge-runtime-__SF_CACHE_VERSION__'");
    expect(source).not.toMatch(/signalforge-runtime-v\d/);
    // Hashed assets are the only cache-first resources; everything else must be network-first.
    expect(source).toMatch(/assets\//);
    expect(source).toContain('networkFirst');
    expect(source).toContain('cacheFirst');
  });

  it('stamps the tracked dist/ worker with the package version and the entry-document hash', () => {
    const swPath = path.resolve('dist/sw.js');
    const indexPath = path.resolve('dist/index.html');
    if (!existsSync(swPath) || !existsSync(indexPath)) return; // dist is rebuilt by the release gates
    const built = readFileSync(swPath, 'utf8');
    const digest = createHash('sha256').update(readFileSync(indexPath)).digest('hex').slice(0, 12);
    expect(built).not.toContain('__SF_CACHE_VERSION__');
    expect(built).toContain(`const CACHE_NAME = 'signalforge-runtime-${version}-${digest}'`);
  });
});
