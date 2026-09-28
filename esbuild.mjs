import * as esbuild from 'esbuild';
import * as fs from 'fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

fs.rmSync('dist', { recursive: true, force: true });   // no stale source maps in a package

// Two bundles: the extension, and the pipeTransport program vsdbg's DAP stream runs through.
const ctx = await esbuild.context({
  entryPoints: { extension: 'src/extension.ts', pipe: 'src/pipe.ts' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outdir: 'dist',
  external: ['vscode', 'cpu-features', '*.node'],   // ssh2's optional native parts; it falls back to JS
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});
if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
