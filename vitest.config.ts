import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // content 面板识别测试用 jsdom
    environmentMatchGlobs: [['test/content-panel.test.ts', 'jsdom']],
    include: ['test/**/*.test.ts'],
  },
});
