import { APP_BASE } from './base';

export type Route =
  | { kind: 'list' }
  | { kind: 'channel'; xUrl: string };

/** Strip the detected app base prefix from the current path → the in-app route string. */
function currentPath(): string {
  let path = location.pathname;
  if (path.startsWith(APP_BASE)) path = path.slice(APP_BASE.length);
  else if (APP_BASE !== '/' && path === APP_BASE.slice(0, -1)) path = '';
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

export function parseRoute(): Route {
  const path = currentPath();
  if (path === '') return { kind: 'list' };
  return { kind: 'channel', xUrl: decodeURIComponent(path) };
}

/** Build a full href (including app base) for a route. */
export function hrefFor(route: Route): string {
  if (route.kind === 'list') return APP_BASE;
  return APP_BASE + encodeURIComponent(route.xUrl) + '/';
}

/**
 * Minimal History-API router. Calls `onChange` on initial load, popstate, and navigate().
 * Intercepts clicks on `<a data-link href>` so in-app links don't trigger full reloads.
 */
export class Router {
  constructor(private readonly onChange: (route: Route) => void) {
    window.addEventListener('popstate', () => this.onChange(parseRoute()));
    document.addEventListener('click', (e) => this.onLinkClick(e));
  }

  start(): void {
    this.onChange(parseRoute());
  }

  navigate(route: Route): void {
    const href = hrefFor(route);
    if (href !== location.pathname) history.pushState(null, '', href);
    this.onChange(route);
  }

  private onLinkClick(e: MouseEvent): void {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const anchor = (e.target as Element | null)?.closest('a[data-link]') as HTMLAnchorElement | null;
    if (!anchor) return;
    e.preventDefault();
    history.pushState(null, '', anchor.getAttribute('href') || APP_BASE);
    this.onChange(parseRoute());
  }
}
