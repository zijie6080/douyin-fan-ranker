import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 默认 node 环境；只有滚动容器 DOM 测试用 jsdom。
    environment: 'node',
    environmentMatchGlobs: [['test/scroll-dom.test.ts', 'jsdom']],
    include: ['test/**/*.test.ts'],
  },
});
