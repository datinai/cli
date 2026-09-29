import { defineConfig } from "tsdown";

// One ESM file. Runtime dependencies stay external; the generated API client (a devDependency) is inlined.
export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: "esm",
  platform: "node",
  clean: true,
  dts: false,
});
