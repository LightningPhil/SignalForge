/**
 * Replaced by the build when report export is integrated into Vite.
 *
 * `typeof` is deliberately used before reading the ambient constant: unbundled
 * Vitest modules do not define it at runtime.
 */
declare const __APP_VERSION__: string | undefined;
declare const __BUILD_ID__: string | undefined;

export const TEST_APP_VERSION = '0.0.0-test';

function declaredBuildVersion(): unknown {
  return typeof __APP_VERSION__ === 'undefined' ? undefined : __APP_VERSION__;
}

export function resolveAppVersion(buildVersion: unknown = declaredBuildVersion()): string {
  return typeof buildVersion === 'string' && buildVersion.trim() ? buildVersion.trim() : TEST_APP_VERSION;
}

export const APP_VERSION = resolveAppVersion();

export function resolveBuildId(
  buildId: unknown = typeof __BUILD_ID__ === 'undefined' ? undefined : __BUILD_ID__
): string {
  return typeof buildId === 'string' && buildId.trim() ? buildId.trim() : 'test';
}

export const APP_BUILD_ID = resolveBuildId();
