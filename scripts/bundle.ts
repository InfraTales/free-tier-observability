/**
 * Bundle the orders function into build/orders/index.js with everything it imports,
 * including the AWS SDK, so the deployed code is exactly what the tests ran.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';

const root = path.join(__dirname, '..');
const outdir = path.join(root, 'build', 'orders');
fs.rmSync(outdir, { recursive: true, force: true });

const result = buildSync({
  entryPoints: [path.join(root, 'app', 'src', 'orders.ts')],
  outfile: path.join(outdir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  minify: true,
  sourcemap: true,
  metafile: true,
  logLevel: 'warning',
});
fs.writeFileSync(path.join(root, 'build', 'meta.json'), JSON.stringify(result.metafile));
console.log(`bundled ${path.relative(root, outdir)}/index.js (${fs.statSync(path.join(outdir, 'index.js')).size} bytes)`);
