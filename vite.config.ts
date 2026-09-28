import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 相對路徑：之後用 Electron 打包上架 Steam 時可直接讀取 dist/ 內的檔案
  base: './',
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 1500 },
  test: { include: ['tests/**/*.test.ts'] },
});
