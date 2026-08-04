#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
await import(resolve(packageRoot, '..', '@rhinoq', 'node', 'dist', 'cli', 'task-migrate.js'));
