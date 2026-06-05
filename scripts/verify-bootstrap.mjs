// Headless verification of the runtime base auto-detection contract.
//
// Emulates nginx Variant B (dist served under /tv/ with `try_files $uri $uri/ /tv/index.html`),
// then runs the EXACT candidate/probe algorithm from index.html against it for a deep-link path,
// asserting it resolves base='/tv/' and can fetch the hashed entry chunk.
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let path = decodeURIComponent(url.pathname);
  if (!path.startsWith(PREFIX)) { res.writeHead(404); return res.end('not found'); }
  const rel = path.slice(PREFIX.length);
  // try_files: $uri, then $uri/index.html, then the SPA fallback /tv/index.html
  const file =
    (await tryFile(join(dist, rel))) ||
    (await tryFile(join(dist, rel, 'index.html'))) ||
    join(dist, 'index.html');
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  res.end(await readFile(file));
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
function isViteManifest(m) {
  if (!m || typeof m !== 'object') return false;
  for (const k in m) if (m[k] && m[k].isEntry) return true;
  return false;
}

async function probe(origin, deepPath) {
  for (const base of buildCandidates(deepPath)) {
    try {
      const r = await fetch(origin + base + 'manifest.json', { cache: 'no-store' });
      if (!r.ok) continue;
      const m = await r.json();
      if (isViteManifest(m)) {
        let entry = null;
        for (const k in m) if (m[k].isEntry) { entry = m[k]; break; }
        return { base, entry };
      }
    } catch { /* HTML fallback / parse error -> keep probing */ }
  }
  return null;
}

const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };

await new Promise((r) => server.listen(0, r));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  // Simulate a deep-link hard refresh at /tv/cnn/ (channel route under the /tv/ mount).
  const found = await probe(origin, '/tv/cnn/');
  if (!found) throw new Error('probe returned null');
  if (found.base !== '/tv/') throw new Error(`expected base /tv/, got ${found.base}`);
  if (!found.entry?.file?.startsWith('assets/')) throw new Error('no hashed entry resolved');

  // The resolved entry must actually be fetchable under the detected base.
  const js = await fetch(origin + found.base + found.entry.file);
  if (!js.ok) throw new Error(`entry not served: ${js.status}`);
  const ct = js.headers.get('content-type') || '';
  if (!ct.includes('javascript')) throw new Error(`entry wrong content-type: ${ct}`);

  // Sanity: CSS link(s) from the manifest are also reachable.
  for (const css of found.entry.css ?? []) {
    const r = await fetch(origin + found.base + css);
    if (!r.ok) throw new Error(`css not served: ${css}`);
  }

  console.log('PASS: deep path /tv/cnn/ -> base', found.base, '-> entry', found.entry.file,
    found.entry.css?.length ? `(+${found.entry.css.length} css)` : '');
} catch (e) {
  fail(e.message);
} finally {
  server.close();
}
