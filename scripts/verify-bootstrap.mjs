// Headless verification of the runtime base auto-detection contract.
//
// Emulates the container nginx routing under a /tv/ mount (base root -> 204; channel paths ->
// index.html; assets -> files; everything else -> 404), then runs the EXACT candidate/probe
// algorithm from index.html against it for a deep-link path, asserting it resolves base='/tv/' via
// the 204 marker and can fetch the baked hashed entry chunk parsed out of dist/index.html.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const PREFIX = '/tv/';

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.html': 'text/html', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };

async function tryFile(p) {
  try { const s = await stat(p); return s.isFile() ? p : null; } catch { return null; }
}

// Mirrors deploy/default.conf, prefixed with /tv/.
const server = createServer(async (req, res) => {
  const head = (status, type) => { res.writeHead(status, type ? { 'content-type': type } : undefined); };
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!path.startsWith(PREFIX)) { head(404); return res.end(); }
  const rel = path.slice(PREFIX.length);

  // Base root -> 204 marker (no app document here).
  if (rel === '') { head(204); return res.end(); }

  // Real assets -> serve the file or 404.
  if (/^(assets|libass|fonts)\//.test(rel)) {
    const file = await tryFile(join(dist, rel));
    if (!file) { head(404); return res.end(); }
    head(200, MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream');
    return res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  }

  // The only app-document shape: "/<id>/" (one path segment, trailing slash) -> index.html.
  if (/^[^/]+\/$/.test(rel)) {
    head(200, 'text/html');
    return res.end(req.method === 'HEAD' ? undefined : await readFile(join(dist, 'index.html')));
  }

  head(404); // multi-segment -> not the shell
  res.end();
});

// --- the algorithm copied verbatim from index.html ---
function buildCandidates(path) {
  const dir = path.charAt(path.length - 1) === '/' ? path : path.slice(0, path.lastIndexOf('/') + 1);
  const candidates = [];
  if (path !== dir) candidates.push(path + '/');
  let cur = dir;
  while (true) {
    candidates.push(cur);
    if (cur === '/' || cur === '') break;
    cur = cur.slice(0, cur.lastIndexOf('/', cur.length - 2) + 1);
  }
  return candidates;
}

async function probeBase(origin, deepPath) {
  for (const base of buildCandidates(deepPath)) {
    try {
      const r = await fetch(origin + base, { method: 'HEAD', cache: 'no-store' });
      if (r.status === 204) return base;
    } catch { /* keep probing */ }
  }
  return null;
}

const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };

await new Promise((r) => server.listen(0, r));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  // The hashed entry is baked into dist/index.html by the inline-entry Vite plugin.
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  const entry = (html.match(/var ENTRY = '([^']*)'/) || [])[1];
  const cssTok = (html.match(/var ENTRY_CSS = '([^']*)'/) || [])[1] ?? '';
  const css = cssTok.split(',').filter(Boolean);
  if (!entry || !entry.startsWith('assets/')) throw new Error(`entry not baked into index.html: ${entry}`);

  // Simulate a deep-link hard refresh at /tv/cnn/ (channel route under the /tv/ mount).
  const base = await probeBase(origin, '/tv/cnn/');
  if (base !== '/tv/') throw new Error(`expected base /tv/, got ${base}`);

  // Routing sanity: base root is the 204 marker; channel path is the shell; deep junk 404s.
  if ((await fetch(origin + '/tv/', { method: 'HEAD' })).status !== 204) throw new Error('base root not 204');
  if ((await fetch(origin + '/tv/cnn/', { method: 'HEAD' })).status !== 200) throw new Error('channel path not 200');
  if ((await fetch(origin + '/tv/a/b/c')).status !== 404) throw new Error('multi-segment path not 404');

  // The baked entry + CSS must be fetchable under the detected base.
  const js = await fetch(origin + base + entry);
  if (!js.ok) throw new Error(`entry not served: ${js.status}`);
  if (!(js.headers.get('content-type') || '').includes('javascript')) throw new Error('entry wrong content-type');
  for (const href of css) {
    const r = await fetch(origin + base + href);
    if (!r.ok) throw new Error(`css not served: ${href}`);
  }

  console.log('PASS: deep /tv/cnn/ -> 204 base', base, '-> entry', entry,
    css.length ? `(+${css.length} css)` : '');
} catch (e) {
  fail(e.message);
} finally {
  server.close();
}
