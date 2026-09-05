import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scopePath = '/SignalForge/';
const cachePrefix = 'signalforge-runtime-';
const cachePlaceholder = '__SF_CACHE_VERSION__';

interface Deployment {
  root: string;
  label: string;
  cacheName: string;
  assetPath: string;
}

interface RunningServer {
  origin: string;
  port: number;
  close: () => Promise<void>;
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

async function serveFile(root: string, requestUrl: string, response: import('node:http').ServerResponse) {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  if (url.pathname === scopePath.slice(0, -1)) {
    response.writeHead(308, { location: scopePath, connection: 'close' });
    response.end();
    return;
  }
  if (!url.pathname.startsWith(scopePath)) {
    response.writeHead(404, { 'cache-control': 'no-store', connection: 'close' });
    response.end('Not found');
    return;
  }

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(url.pathname.slice(scopePath.length));
  } catch {
    response.writeHead(400, { 'cache-control': 'no-store', connection: 'close' });
    response.end('Bad URL');
    return;
  }
  if (!relativePath || relativePath.endsWith('/')) relativePath += 'index.html';

  const absolutePath = path.resolve(root, ...relativePath.split('/'));
  const relativeToRoot = path.relative(root, absolutePath);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    response.writeHead(403, { 'cache-control': 'no-store', connection: 'close' });
    response.end('Forbidden');
    return;
  }

  try {
    const body = await readFile(absolutePath);
    const immutableAsset = relativePath.startsWith('assets/');
    response.writeHead(200, {
      'cache-control': immutableAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'content-length': String(body.byteLength),
      'content-type': contentType(absolutePath),
      'service-worker-allowed': scopePath,
      connection: 'close'
    });
    response.end(body);
  } catch (error) {
    const status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
    response.writeHead(status, { 'cache-control': 'no-store', connection: 'close' });
    response.end(status === 404 ? 'Not found' : 'Server error');
  }
}

async function startDeploymentServer(root: string, requestedPort = 0): Promise<RunningServer> {
  const server: Server = createServer((request, response) => {
    void serveFile(root, request.url || '/', response);
  });
  server.keepAliveTimeout = 1;

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => reject(error);
    server.once('error', handleError);
    server.listen({ host: '127.0.0.1', port: requestedPort, exclusive: true }, () => {
      server.off('error', handleError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  let closed = false;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  };
}

async function createDeployment(parent: string, label: string, workerSource: string, packageVersion: string) {
  const root = path.join(parent, label);
  const assetsRoot = path.join(root, 'assets');
  await mkdir(assetsRoot, { recursive: true });

  const assetName = `app-${label}.js`;
  const assetPath = `${scopePath}assets/${assetName}`;
  const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Service worker deployment ${label}</title>
    <script>
      navigator.serviceWorker.register('/SignalForge/sw.js', { scope: '/SignalForge/' });
    </script>
    <script type="module" src="./assets/${assetName}"></script>
  </head>
  <body><main id="release">loading</main></body>
</html>
`;
  const digest = createHash('sha256').update(indexHtml).digest('hex').slice(0, 12);
  const cacheName = `${cachePrefix}${packageVersion}-${digest}`;
  const builtWorker = workerSource.replaceAll(cachePlaceholder, `${packageVersion}-${digest}`);
  expect(builtWorker).not.toContain(cachePlaceholder);

  await Promise.all([
    writeFile(path.join(root, 'index.html'), indexHtml),
    writeFile(path.join(root, 'sw.js'), builtWorker),
    writeFile(
      path.join(assetsRoot, assetName),
      `document.documentElement.dataset.deployment = ${JSON.stringify(label)};
document.querySelector('#release').textContent = ${JSON.stringify(`deployment ${label}`)};
`
    )
  ]);

  return { root, label, cacheName, assetPath } satisfies Deployment;
}

async function waitForServiceWorkerControl(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
        reject(new Error('Timed out waiting for a service worker controller.'));
      }, 10_000);
      const handleControllerChange = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange, { once: true });
    });
  });
}

async function withTemporaryDirectory(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'signalforge-sw-update-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('updates between deployments, evicts the old cache, and serves new content', async ({ browser }) => {
  test.setTimeout(30_000);
  await withTemporaryDirectory(async (temporaryRoot) => {
    const [workerSource, packageSource] = await Promise.all([
      readFile(path.join(repositoryRoot, 'public', 'sw.js'), 'utf8'),
      readFile(path.join(repositoryRoot, 'package.json'), 'utf8')
    ]);
    expect(workerSource).toContain(cachePlaceholder);
    const packageVersion = (JSON.parse(packageSource) as { version: string }).version;
    const [firstDeployment, secondDeployment] = await Promise.all([
      createDeployment(temporaryRoot, 'one', workerSource, packageVersion),
      createDeployment(temporaryRoot, 'two', workerSource, packageVersion)
    ]);
    expect(firstDeployment.cacheName).not.toBe(secondDeployment.cacheName);

    const context = await browser.newContext({ serviceWorkers: 'allow' });
    let runningServer: RunningServer | null = null;
    const cleanupErrors: unknown[] = [];

    try {
      const page = await context.newPage();
      runningServer = await startDeploymentServer(firstDeployment.root);
      const origin = runningServer.origin;
      const reusedPort = runningServer.port;

      await page.goto(`${origin}${scopePath}`);
      await expect(page.locator('#release')).toHaveText('deployment one');
      await waitForServiceWorkerControl(page);

      const firstAsset = await page.evaluate(async (assetPath) => {
        const response = await fetch(assetPath);
        return { status: response.status, body: await response.text() };
      }, firstDeployment.assetPath);
      expect(firstAsset.status).toBe(200);
      expect(firstAsset.body).toContain('deployment one');
      await expect
        .poll(() => page.evaluate((cacheName) => caches.has(cacheName), firstDeployment.cacheName))
        .toBe(true);

      await runningServer.close();
      runningServer = null;
      runningServer = await startDeploymentServer(secondDeployment.root, reusedPort);
      expect(runningServer.origin).toBe(origin);

      await page.goto(`${origin}${scopePath}?deployment=two`);
      await expect(page.locator('#release')).toHaveText('deployment two');

      await expect
        .poll(() => page.evaluate((cacheName) => caches.has(cacheName), firstDeployment.cacheName))
        .toBe(false);

      const secondAsset = await page.evaluate(async (assetPath) => {
        const response = await fetch(assetPath);
        return { status: response.status, body: await response.text() };
      }, secondDeployment.assetPath);
      expect(secondAsset.status).toBe(200);
      expect(secondAsset.body).toContain('deployment two');

      const runtimeCaches = await page.evaluate(async (prefix) => {
        const keys = await caches.keys();
        return keys.filter((key) => key.startsWith(prefix)).sort();
      }, cachePrefix);
      expect(runtimeCaches).toEqual([secondDeployment.cacheName]);

      const evictedAssetStatus = await page.evaluate(
        async (assetPath) => (await fetch(assetPath, { cache: 'reload' })).status,
        firstDeployment.assetPath
      );
      expect(evictedAssetStatus).toBe(404);

      await runningServer.close();
      runningServer = null;
      const offlineSecondAsset = await page.evaluate(async (assetPath) => {
        const response = await fetch(assetPath);
        return { status: response.status, body: await response.text() };
      }, secondDeployment.assetPath);
      expect(offlineSecondAsset.status).toBe(200);
      expect(offlineSecondAsset.body).toContain('deployment two');
    } finally {
      try {
        await context.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await runningServer?.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    expect(cleanupErrors, 'Service-worker test cleanup failed').toEqual([]);
  });
});
