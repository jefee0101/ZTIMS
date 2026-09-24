import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readdirSync, readFileSync } from 'fs';
import process from 'node:process';

// Every page under src/ is a standalone HTML entry point, so they all have to be
// listed here or the build silently drops them from dist/.
const pages = Object.fromEntries(
  readdirSync(resolve(__dirname, 'src'), { recursive: true })
    .map((file) => String(file).split('\\').join('/'))
    .filter((file) => file.endsWith('.html'))
    .map((file) => [
      'src-' + file.replace(/\.html$/, '').replace(/\//g, '-'),
      resolve(__dirname, 'src', file)
    ])
);

// Pages call the API at /api on their own origin: in production Vercel serves
// the API there too. The dev server has no API of its own, so it passes /api
// through — to the live site by default, as the pages always did before, or to
// a local backend with e.g. ZTIMS_API=http://localhost:8080 npm run dev.
//
// The browser's Origin header is dropped on the way. This hop is
// server-to-server, and without it the API's CORS check would refuse
// http://localhost:3000, which is not (and should not be) on its allow-list.
const apiProxy = {
  '/api': {
    target: process.env.ZTIMS_API || 'https://ztims.vercel.app',
    changeOrigin: true,
    configure: (proxy) => proxy.on('proxyReq', (request) => request.removeHeader('origin'))
  }
};

// src/shared/theme.js is a classic, render-blocking <script> in every page's
// <head>: it has to set the theme before the first paint, and a module script
// always waits until after. Vite bundles only module scripts and leaves a
// classic one's tag alone, so this copies the file into dist/ at the same path,
// where each page's relative src="…shared/theme.js" still finds it.
const classicScripts = ['src/shared/theme.js'];
const copyClassicScripts = {
  name: 'ztims-copy-classic-scripts',
  apply: 'build',
  generateBundle() {
    for (const fileName of classicScripts) {
      this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(fileName, import.meta.url), 'utf8') });
    }
  }
};

export default defineConfig({
  plugins: [copyClassicScripts],
  server: {
    port: 3000,
    proxy: apiProxy
  },
  preview: {
    proxy: apiProxy
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        ...pages
      }
    }
  }
});
