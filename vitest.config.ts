import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          include: ["core/test/**/*.test.ts"],
          setupFiles: ["core/test/purity.setup.ts"],
        },
      },
    ],
  },
});
