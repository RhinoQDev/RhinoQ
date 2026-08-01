import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const config: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@rhinoq/node'],
  turbopack: { root: resolve(process.cwd(), '../..') },
};
export default config;
