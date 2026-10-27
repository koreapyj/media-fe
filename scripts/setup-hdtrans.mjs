// Vendors the hdTrans engine, runtime and dictionary into public/hdtrans/.
// Run automatically via the `postinstall` npm script, or manually:  node scripts/setup-hdtrans.mjs
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'public', 'hdtrans');
mkdirSync(outDir, { recursive: true });

const pkg = join(root, 'node_modules', 'hdtrans');
const assets = [
  ['dist/hdtrans_engine.js', 'hdtrans_engine.js'],
  ['dist/hdtrans_engine.wasm', 'hdtrans_engine.wasm'],
  ['dist/runtime.js', 'runtime.js'],
  ['dist/dicts.hdsnap', 'dicts.hdsnap'],
  ['LICENSE', 'LICENSE'],
  ['THIRD-PARTY-NOTICES.txt', 'THIRD-PARTY-NOTICES.txt'],
];
for (const [from, to] of assets) {
  const src = join(pkg, from);
  if (!existsSync(src)) throw new Error(`Missing hdtrans asset: ${src} (run npm install first)`);
  copyFileSync(src, join(outDir, to));
}
console.log('hdtrans engine + dictionary copied to public/hdtrans/');
