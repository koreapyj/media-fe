// Vendors the libass-wasm (SubtitlesOctopus) runtime assets into public/libass/.
// Run automatically via the `postinstall` npm script, or manually:  node scripts/setup-libass.mjs
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'public', 'libass');
mkdirSync(outDir, { recursive: true });

const pkgJs = join(root, 'node_modules', 'libass-wasm', 'dist', 'js');
const workerAssets = [
  'subtitles-octopus-worker.js',
  'subtitles-octopus-worker.wasm',
  'subtitles-octopus-worker-legacy.js',
];
for (const f of workerAssets) {
  const src = join(pkgJs, f);
  if (!existsSync(src)) throw new Error(`Missing libass asset: ${src} (run npm install first)`);
  copyFileSync(src, join(outDir, f));
}

// Fallback font: not shipped in the npm package; take it from the reference checkout if present,
// otherwise the app still runs (libass uses its built-in default when fallbackFont is absent).
const fontSrc = join(root, '.claude', 'ref', 'JavascriptSubtitlesOctopus', 'assets', 'default.woff2');
if (existsSync(fontSrc)) {
  copyFileSync(fontSrc, join(outDir, 'default.woff2'));
  console.log('libass assets + default.woff2 copied to public/libass/');
} else {
  console.log('libass assets copied to public/libass/ (default.woff2 not found; using libass built-in)');
}
