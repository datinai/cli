import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCredentialStore } from "../src/lib/credentials/store.ts";
import { exitCodes } from "../src/lib/errors.ts";
import { profilePath, writeProfileFile } from "../src/lib/home.ts";
import { datin, json } from "./helpers.ts";

const origin = "https://api.datinapp.com";
const machine = () => {
  const root = mkdtempSync(join(tmpdir(), "datin-account-"));
  return { DATIN_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") };
};

/** A fake API that records what it was asked and answers each route with `answer`. */
function api(answer: (request: Request, body: unknown) => Response) {
  const seen: { method: string; path: string; body: unknown }[] = [];
  return {
    seen,
    respond: async (request: Request) => {
      const text = await request.text();
      const body = text ? JSON.parse(text) : undefined;
      seen.push({ method: request.method, path: new URL(request.url).pathname, body });
      return answer(request, body);
    },
  };
}

const exported = {
  exported_at: "2026-09-30T12:00:00.000Z",
  account: { id: "u1", name: "Ada", email: "ada@example.com", email_verified: true, created_at: "x", linked: [] },
  sessions: [],
  profile: null,
  profile_versions: [],
  contacts: { telegram: "@ada" },
  consents: [],
  sources: [],
  feedback: [],
  decisions: [],
  matches: [],
  match_feedback: [],
};

describe("account export", () => {
  test("prints the export as the command's data, or writes it to an owner-only file", async () => {
    const env = machine();
    await openCredentialStore(env).set(origin, "token");
    const server = api(() => json({ ok: true, data: exported }));

    const printed = await datin(["account", "export"], server.respond, { env });
    expect(printed.exitCode).toBe(0);
    expect(JSON.parse(printed.stdout).data.contacts).toEqual({ telegram: "@ada" });

    const file = join(mkdtempSync(join(tmpdir(), "datin-export-")), "export.json");
    const written = await datin(["account", "export", "--output", file], server.respond, { env });
    expect(JSON.parse(written.stdout).data).toEqual({ written_to: file, exported_at: exported.exported_at });
    expect(JSON.parse(readFileSync(file, "utf8")).account.name).toBe("Ada");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(server.seen.every((r) => r.method === "GET" && r.path === "/v1/account/export")).toBe(true);
  });
});

describe("account delete", () => {
  test("without --yes nothing is sent, and the refusal says what to run after the user's yes", async () => {
    const env = machine();
    await openCredentialStore(env).set(origin, "token");
    const server = api(() => json({}, 500));
    const refused = await datin(["account", "delete"], server.respond, { env });
    expect(refused.exitCode).toBe(exitCodes.confirmation_required);
    expect(JSON.parse(refused.stderr).next[0].command).toBe("datin account delete --yes");
    expect(server.seen).toEqual([]);
  });

  test("with --yes the server is asked to confirm, then the login and local data go too", async () => {
    const env = machine();
    await openCredentialStore(env).set(origin, "token");
    await writeProfileFile(env, "## about\nA draft.\n");
    const server = api(() => json({ ok: true, data: { deleted: true } }));

    const deleted = await datin(["account", "delete", "--yes"], server.respond, { env });
    expect(deleted.exitCode).toBe(0);
    expect(server.seen).toEqual([{ method: "DELETE", path: "/v1/account", body: { confirm: true } }]);
    expect(await openCredentialStore(env).get(origin)).toBeUndefined();
    expect(existsSync(profilePath(env))).toBe(false);
  });
});

describe("block and report", () => {
  test("both are final, so both need --yes before anything is sent", async () => {
    const env = machine();
    await openCredentialStore(env).set(origin, "token");
    const server = api(() => json({}, 500));
    for (const argv of [
      ["block", "p1"],
      ["report", "p1", "--description", "Asked me for money"],
    ]) {
      const refused = await datin(argv, server.respond, { env });
      expect({ argv, exit: refused.exitCode }).toEqual({ argv, exit: exitCodes.confirmation_required });
    }
    expect(server.seen).toEqual([]);
  });

  test("they reach the person's route with the user's words", async () => {
    const env = machine();
    await openCredentialStore(env).set(origin, "token");
    const server = api((request) =>
      new URL(request.url).pathname.endsWith("/report")
        ? json({ ok: true, data: { report_id: "r1", blocked: true } })
        : json({ ok: true, data: { blocked: true } }),
    );
    expect((await datin(["block", "p1", "--yes"], server.respond, { env })).exitCode).toBe(0);
    const reported = await datin(["report", "p2", "--description", "Asked me for money", "--yes"], server.respond, {
      env,
    });
    expect(JSON.parse(reported.stdout).data).toEqual({ report_id: "r1", blocked: true });
    expect(server.seen).toEqual([
      { method: "POST", path: "/v1/people/p1/block", body: undefined },
      { method: "POST", path: "/v1/people/p2/report", body: { description: "Asked me for money" } },
    ]);
  });

  test("report needs the user's account of what happened", async () => {
    const missing = await datin(["report", "p1", "--yes"]);
    expect(missing.exitCode).toBe(exitCodes.usage_error);
  });
});
