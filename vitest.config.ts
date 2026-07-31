import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      // 'server-only' 는 번들러가 클라이언트 유입을 막기 위한 표식일 뿐이라
      // 테스트에서는 빈 모듈로 대체한다.
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
      '@': path.resolve(__dirname, '.'),
    },
  },
});
