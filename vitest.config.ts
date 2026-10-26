import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@hermes/plugin-sdk": new URL("./tests/ui/sdk-stub.tsx", import.meta.url)
        .pathname,
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/ui/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    clearMocks: true,
  },
});
