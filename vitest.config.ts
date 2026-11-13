import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.{ts,tsx}"],
        environment: "happy-dom",
        environmentOptions: { happyDOM: { url: "http://localhost:4173/" } },
        setupFiles: ["tests/support/setup.ts"],
        testTimeout: 60_000,
        maxWorkers: 2,
    },
});
