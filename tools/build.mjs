// Bundles the preloads (sandboxed, so they cannot require local files at run
// time) into dist/preload/. Modules that do not exist yet are replaced by
// empty stubs, so the browser still starts while a part is being written.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const stubs = {
  './media-shim': 'module.exports = { applyMediaShim: function applyMediaShim() {} };',
  './autofill': 'module.exports = { installAutofill: function installAutofill() {} };',
};

const missingStub = {
  name: 'missing-stub',
  setup(b) {
    b.onResolve({ filter: /^\.\/(media-shim|autofill)$/ }, (args) => {
      const file = path.join(args.resolveDir, args.path + '.js');
      if (existsSync(file)) return { path: file };
      console.warn(`build: ${args.path}.js not written yet, using a stub`);
      return { path: args.path, namespace: 'stub' };
    });
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
  },
};

await build({
  absWorkingDir: root,
  entryPoints: ['src/preload/page-preload.js', 'src/preload/ui-preload.js'],
  outdir: 'dist/preload',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'chrome150',
  external: ['electron'],
  minify: process.env.SUPERNOVA_MINIFY === '1',
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [missingStub],
});
console.log('build: dist/preload ready');
