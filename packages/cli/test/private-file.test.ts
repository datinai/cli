import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profilePath, writeProfileFile } from "../src/lib/home.ts";
import { readPrivateJson, writePrivateJson } from "../src/lib/private-file.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "datin-private-"));

describe("private files", () => {
  test("an existing datin.md that others could read is replaced by an owner-only one, with nothing left over", async () => {
    const env = { DATIN_HOME: join(scratch(), "home") };
    mkdirSync(env.DATIN_HOME, { mode: 0o755 });
    writeFileSync(profilePath(env), "old", { mode: 0o644 });
    chmodSync(profilePath(env), 0o644);

    await writeProfileFile(env, "## name\nAda\n");
    expect(readFileSync(profilePath(env), "utf8")).toBe("## name\nAda\n");
    expect(statSync(profilePath(env)).mode & 0o777).toBe(0o600);
    expect(statSync(env.DATIN_HOME).mode & 0o777).toBe(0o700);
    expect(readdirSync(env.DATIN_HOME)).toEqual(["datin.md"]);
  });

  test("parallel writes to one file never collide on the temporary file", async () => {
    const path = join(scratch(), "state.json");
    await Promise.all([writePrivateJson(path, { n: 1 }), writePrivateJson(path, { n: 2 })]);
    expect([1, 2]).toContain(((await readPrivateJson(path)) as { n: number }).n);
    expect(readdirSync(join(path, ".."))).toEqual(["state.json"]);
  });
});
