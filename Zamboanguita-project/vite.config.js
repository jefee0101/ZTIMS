import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readdirSync, readFileSync } from 'fs';
import process from 'node:process';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindForms from '@tailwindcss/forms';
import tailwindContainerQueries from '@tailwindcss/container-queries';
import { transform as esbuildTransform } from 'esbuild';

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

// Tailwind, compiled when the site is built rather than in every visitor's
// browser. In development each page still loads Tailwind's CDN script, which
// reads the page's own `tailwind.config = {…}` and builds the CSS on the fly —
// some 300 KB of JavaScript that then works on every page view, which a phone
// on weak signal (most of Zamboanguita) feels. For the deployed site the same
// CSS is made here, once per page, from that page's own config and from every
// class name the page and its scripts can produce, and written into the page.
// The CDN tag becomes a one-line stand-in so the page's config script still
// runs harmlessly. The CSS goes at the end of <head>, where the CDN put it, so
// the cascade is unchanged.
const TAILWIND_CDN = /<script\s+src="https:\/\/cdn\.tailwindcss\.com[^"]*"\s*><\/script>/;

/* The object in `tailwind.config = { … }`, read by matching braces. */
function pageTailwindConfig(html, fileName) {
  const start = html.indexOf('tailwind.config');
  const open = start < 0 ? -1 : html.indexOf('{', start);
  if (open < 0) throw new Error(`${fileName}: no tailwind.config found`);
  let depth = 0, quote = null;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return new Function(`return (${html.slice(open, i + 1)})`)();
  }
  throw new Error(`${fileName}: tailwind.config is not closed`);
}

const compileTailwind = {
  name: 'ztims-compile-tailwind',
  apply: 'build',
  enforce: 'post',   // after Vite has put the pages into the bundle
  async generateBundle(_options, bundle) {
    const scripts = Object.values(bundle)
      .filter((item) => item.type === 'chunk')
      .map((chunk) => ({ raw: chunk.code, extension: 'js' }));
    for (const file of classicScripts) scripts.push({ raw: readFileSync(new URL(file, import.meta.url), 'utf8'), extension: 'js' });

    for (const item of Object.values(bundle)) {
      if (item.type !== 'asset' || !item.fileName.endsWith('.html')) continue;
      const html = String(item.source);
      if (!TAILWIND_CDN.test(html)) continue;
      const config = pageTailwindConfig(html, item.fileName);
      config.content = [{ raw: html, extension: 'html' }, ...scripts];
      config.plugins = [tailwindForms, tailwindContainerQueries];
      const { css } = await postcss([tailwindcss(config)])
        .process('@tailwind base;@tailwind components;@tailwind utilities;', { from: undefined });
      const { code } = await esbuildTransform(css, { loader: 'css', minify: true });
      item.source = html
        .replace(TAILWIND_CDN, '<script>window.tailwind = window.tailwind || {};</script>')
        .replace('</head>', `<style data-tailwind>${code}</style>\n</head>`);
    }
  }
};

export default defineConfig({
  plugins: [copyClassicScripts, compileTailwind],
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
