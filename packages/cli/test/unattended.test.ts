import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitCodes } from "../src/lib/errors.ts";
import { datin, json } from "./helpers.ts";

const machine = (unattended: string) => {
  const root = mkdtempSync(join(tmpdir(), "datin-unattended-"));
  return {
    DATIN_HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    DATIN_TOKEN: "token",
    DATIN_UNATTENDED: unattended,
  };
};

/** Records every request; answers `check` the way the API does when there is nothing new. */
function api() {
  const seen: string[] = [];
  return {
    seen,
    respond: (request: Request) => {
      const path = new URL(request.url).pathname;
      seen.push(`${request.method} ${path}`);
      if (path === "/v1/check") return json({ ok: true, data: { updates: [], has_more: false } });
      return json({ ok: false, error: { code: "not_found", message: "no", retryable: false } }, 404);
    },
  };
}

describe("unattended runs", () => {
  test("anything that acts for the user is refused before a request is made", async () => {
    const env = machine("1");
    const server = api();
    for (const argv of [
      ["recs", "like", "p1"],
      ["recs", "pass", "p1"],
      ["contacts", "set", "--telegram", "@attacker"],
      ["account", "delete", "--yes"],
      ["block", "p1", "--yes"],
      ["profile", "push"],
    ]) {
      const refused = await datin(argv, server.respond, { env });
      expect({ argv, exit: refused.exitCode }).toEqual({ argv, exit: exitCodes.unattended_refused });
      expect(JSON.parse(refused.stderr).error.hint).toContain("DATIN_UNATTENDED");
    }
    expect(server.seen).toEqual([]);
  });

  test("the check itself and status commands still run", async () => {
    const env = machine("true");
    const server = api();
    expect((await datin(["check"], server.respond, { env })).exitCode).toBe(0);
    expect(server.seen).toEqual(["GET /v1/check"]);
    expect((await datin(["commands"], server.respond, { env })).exitCode).toBe(0);
    expect((await datin(["agent", "instructions", "claude"], server.respond, { env })).exitCode).toBe(0);
  });

  test("an empty, 0 or false value leaves the CLI unrestricted", async () => {
    for (const value of ["", "0", "false"]) {
      const refused = await datin(["recs", "like", "p1"], api().respond, { env: machine(value) });
      expect({ value, exit: refused.exitCode }).not.toEqual({ value, exit: exitCodes.unattended_refused });
    }
  });
});
