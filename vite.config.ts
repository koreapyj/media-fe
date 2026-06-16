import { defineConfig, type Plugin } from 'vite';

// Bake the hashed entry chunk (JS + its CSS) into index.html's bootstrap at build time, so we don't
// emit a Vite manifest.json. In dev there is no bundle, so the tokens are left intact.
function inlineEntry(): Plugin {
  return {
    name: 'inline-entry',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html; // dev server: no bundle
        let js = '';
        let css: string[] = [];
        for (const chunk of Object.values(ctx.bundle)) {
          if (chunk.type === 'chunk' && chunk.isEntry) {
            js = chunk.fileName;
            css = [...(chunk.viteMetadata?.importedCss ?? [])];
          }
        }
        return html.replaceAll('__ENTRY_JS__', js).replaceAll('__ENTRY_CSS__', css.join(','));
      },
    },
  };
}

// Relative base so one build runs under any nginx subpath; the bootstrap detects the mount prefix
// at runtime (see index.html). index.html carries no <script> entry, so main.ts is an explicit input.
export default defineConfig({
  base: './',
  plugins: [inlineEntry()],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: 'index.html',
        main: 'src/main.ts',
      },
    },
  },
});
