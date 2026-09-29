import { defineConfig } from "@hey-api/openapi-ts";

// The client is generated from the spec committed at the repo root; nothing in `src/generated` is edited by hand.
export default defineConfig({
  input: "../../openapi.json",
  output: { path: "./src/generated" },
  plugins: ["@hey-api/client-fetch", "@hey-api/typescript", "@hey-api/sdk"],
});
