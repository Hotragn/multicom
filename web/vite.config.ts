import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    strictPort: true,
  },
  preview: {
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
  test: {
    include: ["ui/**/*.test.ts"],
  },
});
