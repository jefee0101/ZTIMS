import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readdirSync } from 'fs';

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

export default defineConfig({
  server: {
    port: 3000
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
