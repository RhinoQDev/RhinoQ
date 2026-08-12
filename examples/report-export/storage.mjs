import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export class ReportStorage {
  constructor(root) { this.root = resolve(root); }

  async put(key, value) {
    const path = this.path(key);
    const body = Buffer.from(JSON.stringify(value, null, 2));
    await mkdir(this.root, { recursive: true });
    await writeFile(path, body, { flag: 'wx' });
    return { key, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  }

  async inspect(key) {
    try {
      const body = await readFile(this.path(key));
      return { status: 'present', size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'missing' };
      return { status: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async read(key) { return readFile(this.path(key)); }

  path(key) {
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(key)) throw new TypeError('invalid report storage key');
    const path = resolve(this.root, key);
    if (!path.startsWith(`${this.root}${sep}`)) throw new TypeError('report key escapes storage root');
    return path;
  }
}
