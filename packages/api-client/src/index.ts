// Re-exports the generated client. Everything under ./generated comes from openapi.json; run `bun run generate`.

export { type Client, createClient, createConfig } from "./generated/client/index.ts";
export * from "./generated/index.ts";
