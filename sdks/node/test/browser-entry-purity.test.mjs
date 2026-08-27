import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The browser entry point must not reach a Node builtin.
 *
 * This is a bundling constraint that nothing else catches. `dist/browser.js`
 * type-checks, unit-tests and imports cleanly under Node no matter what it
 * pulls in, because Node has every builtin; the failure only appears in an
 * adopter's bundler, as a build error in their application rather than in this
 * package.
 *
 * The graph is easy to grow accidentally: `browser.ts` exports `tasks/http.js`,
 * which imports `gateway/client.js`, so a single static import added to the
 * Gateway client lands in the browser bundle even though neither file looks
 * browser-facing.
 */
const root = path.resolve(import.meta.dirname, '..');

function reachableFiles(entry) {
  const seen = new Set();
  const builtins = new Map();
  const queue = [path.resolve(root, entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) {
        const importers = builtins.get(specifier) ?? [];
        importers.push(path.relative(root, file).replaceAll('\\', '/'));
        builtins.set(specifier, importers);
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      queue.push(path.resolve(path.dirname(file), specifier));
    }
  }
  return { seen, builtins };
}

test('the browser entry point reaches no Node builtin', () => {
  const { seen, builtins } = reachableFiles('dist/browser.js');
  // A graph of one file means resolution silently failed and the assertion
  // below would pass without checking anything.
  assert.ok(seen.size > 5, `expected a real import graph, walked ${seen.size} files`);

  const offenders = [...builtins.entries()].map(
    ([specifier, importers]) => `${specifier} <- ${importers.join(', ')}`,
  );
  assert.deepEqual(
    offenders,
    [],
    'the browser bundle must not import Node builtins:\n  ' + offenders.join('\n  '),
  );
});

test('the Node entry point does carry the async context module', () => {
  // The mirror of the test above: the ambient trace has to work under Node, so
  // a "fix" that removed async_hooks everywhere would be caught here rather
  // than silently disabling correlation.
  const { builtins } = reachableFiles('dist/index.js');
  assert.ok(
    builtins.has('node:async_hooks'),
    'the Node entry must reach node:async_hooks so withTrace works',
  );
});
