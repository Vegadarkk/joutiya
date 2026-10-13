import { defineConfig } from "vitest/config";

// Firestore security rules against the emulator (npm run test:rules starts it).
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/rules/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
