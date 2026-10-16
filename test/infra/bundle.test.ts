/**
 * The function ships as one self-contained index.js. Check nothing is left for Lambda to
 * resolve at runtime, and that the bundle loads and exports the handler.
 */
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { BUNDLE_DIR } from '../../infra/lib/orders-stack';

test('index.js sits at the package root, with only its source map beside it', () => {
  expect(fs.readdirSync(BUNDLE_DIR).sort()).toEqual(['index.js', 'index.js.map']);
});

test('the bundle imports nothing outside Node.js itself', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, '..', 'meta.json'), 'utf8')) as {
    outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
  };
  const builtins = new Set(builtinModules);
  const external = Object.values(meta.outputs)
    .flatMap((o) => o.imports)
    .filter((i) => i.external)
    .map((i) => i.path.replace(/^node:/, ''))
    .filter((p) => !builtins.has(p));
  expect([...new Set(external)]).toEqual([]);
});

test('the bundle loads and exports a handler', () => {
  const mod = require(path.join(BUNDLE_DIR, 'index.js')) as { handler?: unknown };
  expect(typeof mod.handler).toBe('function');
});
