import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // lib/health.ts builds its own Upstash client from these. Blank them so
    // no test can write to a real Redis from a developer shell's env; tests
    // that exercise health capture set them and mock @upstash/redis.
    env: { UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' },
  },
});
