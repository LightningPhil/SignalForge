import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repositoryRoot, 'dist');
const distPrefix = 'dist/';
const cachePlaceholder = '__SF_CACHE_VERSION__';
const failures = [];
const artifactExtensions = new Set([
  '.avif',
  '.css',
  '.gif',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.png',
  '.svg',
  '.txt',
  '.wasm',
  '.webmanifest',
  '.webp',
  '.woff',
  '.woff2',
  '.xml'
]);
const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.svg',
  '.txt',
  '.webmanifest',
  '.xml'
]);

function usage() {
  console.log(`Usage: node scripts/verify-dist.mjs [--post-build | --artifact-only]

  (default)       Verify dist's files and content against the Git index, then check artifact integrity.
  --post-build    Explicit strict mode for use immediately after a clean build. This script never runs a build.
  --artifact-only Check artifact integrity without comparing dist to Git (useful before staging a new build).
  --help          Show this help.`);
}

function parseMode(args) {
  let mode = 'tracked';
  for (const argument of args) {
    if (argument === '--help' || argument === '-h') return 'help';
    if (argument === '--post-build') {
      if (mode !== 'tracked') throw new Error('--post-build and --artifact-only cannot be combined.');
      mode = 'post-build';
      continue;
    }
    if (argument === '--artifact-only') {
      if (mode === 'post-build') throw new Error('--post-build and --artifact-only cannot be combined.');
      mode = 'artifact-only';
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return mode;
}

function addFailure(message) {
  failures.push(message);
}

function displayList(label, items, limit = 30) {
  if (items.length === 0) return;
  const shown = items.slice(0, limit);
  addFailure(
    `${label}:\n${shown.map((item) => `    ${item}`).join('\n')}${items.length > limit ? `\n    ... and ${items.length - limit} more` : ''}`
  );
}

async function walkFiles(directory, relativeDirectory = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      addFailure(`dist must not contain symbolic links: ${distPrefix}${relativePath}`);
    } else if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolutePath, relativePath)));
    } else if (entry.isFile()) {
      files.push(`${distPrefix}${relativePath}`);
    } else {
      addFailure(`dist contains an unsupported filesystem entry: ${distPrefix}${relativePath}`);
    }
  }
  return files.sort();
}

function runGit(args, input) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: null,
    input,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) throw new Error(`Unable to run Git: ${result.error.message}`);
  if (result.status !== 0) {
    const details = result.stderr?.toString('utf8').trim();
    throw new Error(`git ${args.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
  return result.stdout;
}

function readTrackedIndex() {
  const output = runGit(['ls-files', '--stage', '-z', '--', 'dist']).toString('utf8');
  const tracked = new Map();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const match = record.match(/^(\d+) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/);
    if (!match) throw new Error(`Could not parse Git index record: ${JSON.stringify(record)}`);
    const [, , objectId, stage, filePath] = match;
    if (stage !== '0') throw new Error(`Unmerged Git index entry prevents dist verification: ${filePath}`);
    tracked.set(filePath, objectId);
  }
  return tracked;
}

function hashWorktreeFiles(filePaths) {
  if (filePaths.length === 0) return new Map();
  const unsupportedPath = filePaths.find((filePath) => filePath.includes('\n') || filePath.includes('\r'));
  if (unsupportedPath)
    throw new Error(`dist filename contains an unsupported newline: ${JSON.stringify(unsupportedPath)}`);

  // Let Git apply the same attributes and line-ending normalization used by the index. This keeps
  // the check meaningful on both LF and core.autocrlf checkouts while still hashing binary files.
  const output = runGit(['hash-object', '--stdin-paths'], Buffer.from(`${filePaths.join('\n')}\n`))
    .toString('utf8')
    .trimEnd()
    .split(/\r?\n/);
  if (output.length !== filePaths.length) {
    throw new Error(`Git hashed ${output.length} worktree files, but ${filePaths.length} were requested.`);
  }
  return new Map(filePaths.map((filePath, index) => [filePath, output[index]]));
}

async function verifyTrackedTreeAndContent(actualFiles) {
  const tracked = readTrackedIndex();
  const actualSet = new Set(actualFiles);
  const trackedFiles = [...tracked.keys()].sort();

  displayList(
    'Files present in dist but absent from the Git index',
    actualFiles.filter((filePath) => !tracked.has(filePath))
  );
  displayList(
    'Files tracked in the Git index but absent from dist',
    trackedFiles.filter((filePath) => !actualSet.has(filePath))
  );

  const commonFiles = trackedFiles.filter((filePath) => actualSet.has(filePath));
  const worktreeHashes = hashWorktreeFiles(commonFiles);
  const changedFiles = [];
  for (const filePath of commonFiles) {
    if (tracked.get(filePath) !== worktreeHashes.get(filePath)) changedFiles.push(filePath);
  }
  displayList('Files whose content differs from the Git index', changedFiles);
}

function extractHtmlReferences(source) {
  const references = [];
  const attributePattern = /\b(?:src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const match of source.matchAll(attributePattern)) references.push(match[1] ?? match[2] ?? match[3]);

  const srcsetPattern = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of source.matchAll(srcsetPattern)) {
    const srcset = match[1] ?? match[2] ?? '';
    for (const candidate of srcset.split(',')) {
      const reference = candidate.trim().split(/\s+/, 1)[0];
      if (reference) references.push(reference);
    }
  }
  return references;
}

function extractChunkReferences(source, extension) {
  const references = [];
  const quotedPathPattern = /(["'`])((?:\.{1,2}\/|\/)[^"'`\r\n\\]+)\1/g;
  for (const match of source.matchAll(quotedPathPattern)) {
    const reference = match[2];
    const pathname = reference.split(/[?#]/, 1)[0].toLowerCase();
    if (artifactExtensions.has(path.posix.extname(pathname))) references.push(reference);
  }

  if (extension === '.css') {
    const cssUrlPattern = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi;
    for (const match of source.matchAll(cssUrlPattern)) references.push(match[1] ?? match[2] ?? match[3]);
    const cssImportPattern = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
    for (const match of source.matchAll(cssImportPattern)) references.push(match[1] ?? match[2]);
  }

  const sourceMapPattern = /[#@]\s*sourceMappingURL=([^\s*]+)/g;
  for (const match of source.matchAll(sourceMapPattern)) references.push(match[1]);
  return references;
}

function isIgnoredReference(reference) {
  const trimmed = reference.trim();
  return (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('//') ||
    /^(?:blob|data|javascript|mailto|tel):/i.test(trimmed) ||
    /^[a-z][a-z\d+.-]*:/i.test(trimmed)
  );
}

function inferDeploymentBase(indexHtml) {
  const baseMatch = indexHtml.match(/<base\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
  if (baseMatch) {
    const pathname = new URL(baseMatch[1] ?? baseMatch[2], 'https://dist.invalid/').pathname;
    return pathname.endsWith('/') ? pathname : `${pathname}/`;
  }

  for (const reference of extractHtmlReferences(indexHtml)) {
    if (!reference.startsWith('/') || reference.startsWith('//')) continue;
    const pathname = new URL(reference, 'https://dist.invalid/').pathname;
    const assetsMarker = pathname.indexOf('/assets/');
    if (assetsMarker >= 0) return pathname.slice(0, assetsMarker + 1);
  }
  return '/';
}

function resolveArtifactReference(sourceFile, reference, deploymentBase) {
  if (isIgnoredReference(reference)) return null;
  if (reference.includes('\\')) throw new Error('backslashes are not valid in deployment URLs');

  const relativeSource = sourceFile.slice(distPrefix.length);
  const sourcePathname = `${deploymentBase}${relativeSource
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
  const resolved = new URL(reference, `https://dist.invalid${sourcePathname}`);
  if (resolved.origin !== 'https://dist.invalid') return null;

  let pathname;
  try {
    pathname = decodeURIComponent(resolved.pathname);
  } catch {
    throw new Error('URL contains invalid percent encoding');
  }
  if (!pathname.startsWith(deploymentBase)) {
    throw new Error(`URL resolves outside deployment base ${deploymentBase}`);
  }

  let relativeTarget = pathname.slice(deploymentBase.length);
  if (!relativeTarget || relativeTarget.endsWith('/')) relativeTarget += 'index.html';
  relativeTarget = path.posix.normalize(relativeTarget);
  if (relativeTarget === '..' || relativeTarget.startsWith('../') || path.posix.isAbsolute(relativeTarget)) {
    throw new Error('URL resolves outside dist');
  }
  return `${distPrefix}${relativeTarget}`;
}

async function verifyReferences(actualFiles, indexHtml) {
  const actualSet = new Set(actualFiles);
  const deploymentBase = inferDeploymentBase(indexHtml);
  const missingReferences = [];
  const invalidReferences = [];

  for (const sourceFile of actualFiles) {
    const extension = path.posix.extname(sourceFile).toLowerCase();
    if (extension !== '.html' && extension !== '.js' && extension !== '.mjs' && extension !== '.css') continue;
    const source = await readFile(path.join(repositoryRoot, ...sourceFile.split('/')), 'utf8');
    const references =
      extension === '.html'
        ? [...extractHtmlReferences(source), ...extractChunkReferences(source, extension)]
        : extractChunkReferences(source, extension);

    for (const reference of new Set(references)) {
      try {
        const target = resolveArtifactReference(sourceFile, reference, deploymentBase);
        if (target && !actualSet.has(target)) missingReferences.push(`${sourceFile} -> ${reference} (${target})`);
      } catch (error) {
        invalidReferences.push(`${sourceFile} -> ${reference}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  displayList('Local HTML/chunk references whose target is missing', missingReferences);
  displayList('Invalid local HTML/chunk references', invalidReferences);
}

async function verifyArtifact(actualFiles) {
  const actualSet = new Set(actualFiles);
  const requiredFiles = ['dist/.nojekyll', 'dist/THIRD_PARTY_NOTICES.txt', 'dist/index.html', 'dist/sw.js'];
  displayList(
    'Required deployment files are missing',
    requiredFiles.filter((filePath) => !actualSet.has(filePath))
  );

  const noticesPath = path.join(distRoot, 'THIRD_PARTY_NOTICES.txt');
  if (actualSet.has('dist/THIRD_PARTY_NOTICES.txt')) {
    const notices = await readFile(noticesPath, 'utf8');
    if (!notices.trim()) addFailure('dist/THIRD_PARTY_NOTICES.txt must not be empty.');
  }

  let indexHtml = null;
  if (actualSet.has('dist/index.html')) {
    indexHtml = await readFile(path.join(distRoot, 'index.html'), 'utf8');
    await verifyReferences(actualFiles, indexHtml);
  }

  const placeholderFiles = [];
  for (const filePath of actualFiles) {
    if (!textExtensions.has(path.posix.extname(filePath).toLowerCase())) continue;
    const source = await readFile(path.join(repositoryRoot, ...filePath.split('/')), 'utf8');
    if (source.includes(cachePlaceholder)) placeholderFiles.push(filePath);
  }
  displayList(`Build placeholder ${cachePlaceholder} remains in deployment files`, placeholderFiles);

  if (indexHtml !== null && actualSet.has('dist/sw.js')) {
    const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
    if (typeof packageJson.version !== 'string' || !packageJson.version) {
      addFailure('package.json must contain a non-empty string version.');
    } else {
      const digest = createHash('sha256')
        .update(await readFile(path.join(distRoot, 'index.html')))
        .digest('hex')
        .slice(0, 12);
      const expectedCacheName = `signalforge-runtime-${packageJson.version}-${digest}`;
      const serviceWorker = await readFile(path.join(distRoot, 'sw.js'), 'utf8');
      const declarations = [...serviceWorker.matchAll(/\bconst\s+CACHE_NAME\s*=\s*(['"])([^'"]+)\1/g)].map(
        (match) => match[2]
      );
      if (declarations.length !== 1) {
        addFailure(
          `dist/sw.js must contain exactly one constant CACHE_NAME declaration; found ${declarations.length}.`
        );
      } else if (declarations[0] !== expectedCacheName) {
        addFailure(`dist/sw.js cache stamp is ${declarations[0]}; expected ${expectedCacheName}.`);
      }
    }
  }
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  if (mode === 'help') {
    usage();
    return;
  }

  const distStat = await lstat(distRoot).catch(() => null);
  if (!distStat?.isDirectory()) throw new Error(`Missing dist directory: ${distRoot}`);
  const actualFiles = await walkFiles(distRoot);
  if (actualFiles.length === 0) addFailure('dist is empty.');

  if (mode !== 'artifact-only') await verifyTrackedTreeAndContent(actualFiles);
  await verifyArtifact(actualFiles);

  if (failures.length > 0) {
    console.error(`dist verification failed with ${failures.length} problem${failures.length === 1 ? '' : 's'}:`);
    failures.forEach((failure, index) => console.error(`\n${index + 1}. ${failure}`));
    process.exitCode = 1;
    return;
  }

  const comparison = mode === 'artifact-only' ? 'artifact integrity' : 'Git-index parity and artifact integrity';
  console.log(`dist verification passed (${comparison}; ${actualFiles.length} files).`);
}

main().catch((error) => {
  console.error(`dist verification could not run: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
