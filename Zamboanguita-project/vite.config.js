import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: {
    port: 3000
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        userLogin: resolve(__dirname, 'src/user/user_login.html'),
        adminLogin: resolve(__dirname, 'src/admin/admin_login.html')
      }
    }
  }
});