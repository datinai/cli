import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const targets = [
  { name: "darwin-arm64", bun: "bun-darwin-arm64" },
  { name: "darwin-x64", bun: "bun-darwin-x64" },
  { name: "linux-arm64", bun: "bun-linux-arm64" },
  { name: "linux-x64", bun: "bun-linux-x64" },
  { name: "windows-arm64", bun: "bun-windows-arm64" },
  { name: "windows-x64", bun: "bun-windows-x64" },
] as const;

const { values } = parseArgs({ options: { target: { type: "string" } } });
const requested = values.target ?? `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const selected = targets.filter((target) => requested === "all" || target.name === requested);
if (!selected.length)
  throw new Error(`Unknown target: ${requested}. Use ${targets.map((t) => t.name).join(", ")}, or all.`);

const root = new URL("../", import.meta.url);
for (const target of selected) {
  const directory = new URL(`dist/artifacts/${target.name}/`, root);
  await mkdir(directory, { recursive: true });
  const outfile = fileURLToPath(new URL(target.name.startsWith("windows-") ? "datin.exe" : "datin", directory));
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("packages/cli/src/bin.ts", root))],
    minify: true,
    compile: {
      target: target.bun,
      outfile,
      // Match the npm CLI: an unrelated working directory must not configure Datin.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${target.name}`);
  console.log(outfile);
}
