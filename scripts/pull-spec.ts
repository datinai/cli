// Refreshes openapi.json from the live API. Follow with `bun run generate` and commit both together.
import { fileURLToPath } from "node:url";

const url = process.env.DATIN_API_URL ?? "https://api.datinapp.com";
const response = await fetch(`${url}/v1/openapi.json`);
if (!response.ok) throw new Error(`${url} answered ${response.status}`);
await Bun.write(
  fileURLToPath(new URL("../openapi.json", import.meta.url)),
  `${JSON.stringify(await response.json(), null, 2)}\n`,
);
console.log(`openapi.json refreshed from ${url}`);
