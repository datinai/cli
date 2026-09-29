import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the built file with plain Node, the way `npx datin` / `bunx datin` would, in an empty home with
// telemetry off: the developer's own login, state and telemetry choice must never be read or written.
const bin = new URL("../dist/bin.mjs", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "datin-binary-"));
const env = {
  PATH: process.env.PATH ?? "",
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  DATIN_HOME: join(root, "datin"),
  DATIN_TELEMETRY_DISABLED: "1",
};
const node = (args: string[]) => spawnSync("node", [bin, ...args], { encoding: "utf8", env });

test("the built binary runs under Node and prints JSON when piped", () => {
  const result = node(["commands"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).ok).toBe(true);
  expect(result.stderr).toBe("");
});

test("the built binary exits 2 with a typed error for a bad command", () => {
  const result = node(["nope"]);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stderr).error.code).toBe("usage_error");
});
