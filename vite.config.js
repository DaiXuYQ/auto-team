import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8786',
      '/mcp': process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8786',
    },
  },
});
