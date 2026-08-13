#!/usr/bin/env node
/**
 * Generates the Prisma client only when it is actually out of date.
 *
 * Two facts have to hold at once:
 *
 *   1. A CLEAN CHECKOUT MUST BUILD. The client is generated, not committed, and
 *      hub/src imports types from it — so with no client, nothing compiles. This is
 *      the bug that made the repo unbuildable from a fresh clone for several commits.
 *
 *   2. TESTS MUST RUN WHILE THE HUB IS RUNNING. On Windows the query engine is a
 *      loaded DLL, and `prisma generate` fails with EPERM trying to rename a file the
 *      running process holds open. Generating unconditionally therefore made
 *      `pnpm test` impossible during development, which is exactly when it is useful.
 *
 * Comparing timestamps satisfies both: a missing or stale client is generated, an
 * up-to-date one is left alone and never touches the locked file.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = join(hubRoot, 'prisma', 'schema.prisma');

function generate(reason) {
  console.log(`prisma generate — ${reason}`);
  const result = spawnSync('prisma', ['generate'], {
    cwd: hubRoot,
    stdio: 'inherit',
    shell: true,
  });
  process.exit(result.status ?? 1);
}

if (!existsSync(schema)) {
  console.error(`No schema at ${schema}`);
  process.exit(1);
}

/**
 * Locates the generated client.
 *
 * `.prisma/client` is NOT resolvable from here: pnpm places it as a sibling of
 * `@prisma` inside the store directory that `@prisma/client` itself lives in, which no
 * amount of resolution from hub/ will reach. So resolve the package we CAN see, then
 * look for `.prisma/client` in the node_modules folders above it.
 */
function findGeneratedClient() {
  const require = createRequire(join(hubRoot, 'package.json'));

  let dir;
  try {
    dir = dirname(require.resolve('@prisma/client/package.json'));
  } catch {
    return null;
  }

  // Walk up: .../node_modules/@prisma/client -> .../node_modules -> check .prisma/client
  for (let i = 0; i < 6 && dir; i += 1) {
    const candidate = join(dir, 'node_modules', '.prisma', 'client', 'index.js');
    if (existsSync(candidate)) return candidate;

    const sibling = join(dir, '..', '.prisma', 'client', 'index.js');
    if (existsSync(sibling)) return sibling;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

const clientIndex = findGeneratedClient();

if (!clientIndex) {
  generate('no generated client found');
}

if (statSync(schema).mtimeMs > statSync(clientIndex).mtimeMs) {
  // A schema edit must regenerate, even though that will fail while the hub holds the
  // engine open — in that case stopping the hub is genuinely required, and the EPERM
  // says so far more usefully than silently compiling against stale types would.
  generate('schema is newer than the generated client');
}

// Up to date. Say nothing: this runs before every test invocation.
