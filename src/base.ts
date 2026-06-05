/**
 * Application base path detected at runtime by the inline bootstrap in index.html
 * (window.__APP_BASE__). Always starts and ends with `/`. Falls back to `/` in dev.
 */
export const APP_BASE: string = (() => {
  let base = window.__APP_BASE__ ?? '/';
  if (!base.startsWith('/')) base = '/' + base;
  if (!base.endsWith('/')) base += '/';
  return base;
})();

/** Resolve a path relative to the app base (for assets served alongside index.html). */
export function asset(path: string): string {
  return APP_BASE + path.replace(/^\//, '');
}
