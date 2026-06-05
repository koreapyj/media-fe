import { defineConfig } from 'vite';

// Relative base so a single build runs under ANY nginx subpath. The inline bootstrap in
// index.html probes upward for manifest.json to discover the real mount prefix at runtime,
// sets <base href>, and loads the hashed entry from it (see index.html / src/base.ts).
export default defineConfig({
  base: './',
  build: {
    // Emits dist/manifest.json at the build root; the bootstrap uses it as the root marker
    // AND to resolve the hashed entry chunk.
    manifest: 'manifest.json',
    target: 'es2022',
    rollupOptions: {
      // index.html carries no <script> entry (the bootstrap injects it from the manifest), so the
      // JS entry is listed explicitly. Both are inputs: index.html is emitted as HTML, src/main.ts
      // becomes the hashed, manifest-tracked entry chunk.
      input: {
        index: 'index.html',
        main: 'src/main.ts',
      },
    },
  },
});
