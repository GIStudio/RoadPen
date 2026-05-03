import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  base: mode === 'github-pages' ? '/RoadPen/' : '/',
  server: {
    host: '127.0.0.1',
    port: 4173,
  },
}));
