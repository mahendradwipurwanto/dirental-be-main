/**
 * Generates public/openapi.json from the route registry.
 * Usage: pnpm gen:openapi        (write)
 *        pnpm check:openapi      (exit 1 if the committed file is stale)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Registers every route as a side effect.
await import('../src/routes.js');
const { generateOpenApiDocument } = await import('../src/lib/openapi.js');

const doc = generateOpenApiDocument();
const json = JSON.stringify(doc, null, 2) + '\n';
const out = resolve(process.cwd(), 'public/openapi.json');
const check = process.argv.includes('--check');

if (check) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {
    /* missing */
  }
  if (current !== json) {
    console.error('openapi.json is stale. Run `pnpm gen:openapi` and commit the result.');
    process.exit(1);
  }
  console.log('openapi.json is up to date.');
} else {
  mkdirSync(resolve(process.cwd(), 'public'), { recursive: true });
  writeFileSync(out, json);
  const paths = Object.keys(doc.paths ?? {}).length;
  console.log(`Wrote ${out} (${paths} paths)`);
}
process.exit(0);
