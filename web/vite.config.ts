import { defineConfig } from "vite";

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
    passWithNoTests: true,
    include: ["ui/**/*.test.ts"],
  },
});
