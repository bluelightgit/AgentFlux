import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "node:fs": new URL("./tests/mocks/node-fs.ts", import.meta.url).pathname,
      "node:path": new URL("./tests/mocks/node-path.ts", import.meta.url).pathname,
    },
  },
});
