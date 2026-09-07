import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@todocue/shared": r("./packages/shared/src/index.ts"),
      "@todocue/engine": r("./packages/engine/src/index.ts"),
      "@todocue/server": r("./packages/server/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
  },
});
