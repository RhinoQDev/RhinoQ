// A content hash of everything the build reads, so a built artefact can prove
// which source it came from. Version numbers cannot: a tarball keeps the name
// it was packed under while the source moves on beneath it, which is how an
// artefact built before a feature landed came to be installed as if it
// contained that feature.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Files outside src/ that change what the build emits. */
const EXTRA_INPUTS = ['package.json', 'tsconfig.json', 'tsconfig.cjs.json'];

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(absolute)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

/**
 * Hashes each input as `relative-path\0content\0` so that renaming a file
 * changes the hash even when its bytes do not. Paths are normalised to forward
 * slashes and sorted, so Windows and Linux builds of the same commit agree.
 */
export async function computeSourceHash() {
  const sourceFiles = await collectSourceFiles(join(PACKAGE_ROOT, 'src'));
  const inputs = [
    ...sourceFiles.map((absolute) => relative(PACKAGE_ROOT, absolute)),
    ...EXTRA_INPUTS,
  ]
    .map((path) => path.split(sep).join('/'))
    .sort();

  const digest = createHash('sha256');
  for (const path of inputs) {
    digest.update(path);
    digest.update('\0');
    digest.update(await readFile(join(PACKAGE_ROOT, path)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

export { PACKAGE_ROOT };
