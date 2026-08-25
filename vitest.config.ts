import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // vitest 4 の defaultExclude は node_modules と .git のみで、v3 まで含まれていた
    // dist が外れている。除外しないと `pnpm run build` 後の実行が dist/test/*.test.js を
    // 二重に収集し、コンパイル済みの古いテストが緑になる。
    exclude: [...defaultExclude, "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/server/index.ts", "src/client/cli.ts"],
    },
  },
});
