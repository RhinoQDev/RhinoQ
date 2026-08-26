import { defineConfig } from 'vite';

const proxy = {
  '/api/rhinoq/tasks': {
    target: 'http://127.0.0.1:18891',
    changeOrigin: false,
    rewrite: (path: string) => path.replace(/^\/api\/rhinoq\/tasks/, '/tasks'),
  },
  '/demo-artifacts': { target: 'http://127.0.0.1:18891', changeOrigin: false },
  '/demo-results': { target: 'http://127.0.0.1:18891', changeOrigin: false },
};

export default defineConfig({
  server: {
    port: 4173,
    strictPort: true,
    proxy,
  },
  preview: { port: 4173, strictPort: true, proxy },
});
