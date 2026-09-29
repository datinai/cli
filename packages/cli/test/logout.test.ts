import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCredentialStore } from "../src/lib/credentials/store.ts";
import { exitCodes } from "../src/lib/errors.ts";
import { hashOf, profilePath, statePath, updateState, writeProfileFile } from "../src/lib/home.ts";
import { evidenceDir, markStatus, readEvidenceSnapshot, recordDecision } from "../src/lib/local-sources.ts";
import { logoutPaths } from "../src/lib/logout.ts";
import { configDir } from "../src/lib/paths.ts";
import { pendingLogin } from "../src/lib/pending-login.ts";
import { datin, json } from "./helpers.ts";

const origin = "https://api.datinapp.com";
const staging = "https://staging.example.com";
const draft = "## about\nI like hiking.\n";
const machine = () => {
  const root = mkdtempSync(join(tmpdir(), "datin-logout-"));
  return { DATIN_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") };
};

async function withProfile(synced: boolean) {
  const env = machine();
  await openCredentialStore(env).set(origin, "saved-token");
  await writeProfileFile(env, draft);
  await updateState(env, {
    version: 3,
    syncedHash: synced ? hashOf(draft) : hashOf("old profile"),
    modelChecked: true,
  });
  await recordDecision(env, "codex-history", { consent: "granted", consentVersion: 1 }, new Date());
  await markStatus(env, "codex-history", "done");
  mkdirSync(evidenceDir(env), { recursive: true });
  writeFileSync(join(evidenceDir(env), "codex-history.md"), "Local evidence");
  if (synced) await updateState(env, { syncedEvidenceHash: (await readEvidenceSnapshot(env)).hash });
  return env;
}

function api() {
  const requests: Request[] = [];
  return {
    requests,
    respond: (request: Request) => {
      requests.push(request);
      expect(new URL(request.url).pathname).toBe("/v1/auth/logout");
      return json({ ok: true, data: { logged_out: true } });
    },
  };
}

function expectCleared(env: ReturnType<typeof machine>) {
  const paths = logoutPaths(env);
  for (const path of [...paths.files, paths.evidence]) expect(existsSync(path)).toBe(false);
}

describe("logout clears local work with confirmation only when unfinished", () => {
  test("editing only the draft does not also warn about unchanged evidence", async () => {
    const env = await withProfile(true);
    await writeProfileFile(env, `${draft}\nAn unpushed edit.\n`);
    const server = api();
    const result = await datin(["logout"], server.respond, { env });
    expect(result.exitCode).toBe(exitCodes.confirmation_required);
    expect(JSON.parse(result.stderr).error.details.unfinished).toEqual(["unpushed profile draft"]);
    expect(server.requests).toHaveLength(0);
  });

  test("pulling a saved profile does not mark local evidence as reviewed", async () => {
    const env = machine();
    await openCredentialStore(env).set(origin, "saved-token");
    mkdirSync(evidenceDir(env), { recursive: true });
    const evidence = join(evidenceDir(env), "codex-history.md");
    writeFileSync(evidence, "New local findings");
    const pull = await datin(
      ["profile", "pull"],
      (request) => {
        expect(new URL(request.url).pathname).toBe("/v1/profile");
        expect(request.method).toBe("GET");
        return json({
          ok: true,
          data: {
            markdown: draft,
            version: 3,
            status: "active",
            updated_at: "2026-09-20T00:00:00Z",
          },
        });
      },
      { env },
    );
    expect(pull.exitCode).toBe(0);
    const server = api();
    const result = await datin(["logout"], server.respond, { env });
    expect(result.exitCode).toBe(exitCodes.confirmation_required);
    expect(JSON.parse(result.stderr).error.details.unfinished).toEqual([
      "local evidence not included in the last profile sync",
    ]);
    expect(server.requests).toHaveLength(0);
    expect(readFileSync(evidence, "utf8")).toBe("New local findings");
    expect(await openCredentialStore(env).get(origin)).toBe("saved-token");
  });

  test("unexpected evidence entries count as unfinished work, and --yes clears them without following links", async () => {
    for (const kind of ["directory", "file-link", "root-link"] as const) {
      const env = machine();
      const outside = mkdtempSync(join(tmpdir(), "datin-external-evidence-"));
      const external = join(outside, "keep.md");
      writeFileSync(external, "External file");
      mkdirSync(env.DATIN_HOME, { recursive: true });
      if (kind === "root-link") symlinkSync(outside, evidenceDir(env), "dir");
      else {
        mkdirSync(evidenceDir(env));
        const entry = join(evidenceDir(env), "unexpected");
        if (kind === "file-link") symlinkSync(external, entry);
        else {
          mkdirSync(entry);
          writeFileSync(join(entry, "nested.md"), "Untracked work");
        }
      }
      const server = api();
      const result = await datin(["logout"], server.respond, { env });
      expect(result.exitCode).toBe(exitCodes.confirmation_required);
      expect(result.stdout).toBe("");
      expect(existsSync(evidenceDir(env))).toBe(true);
      expect(server.requests).toHaveLength(0);
      expect((await datin(["logout", "--yes"], server.respond, { env })).exitCode).toBe(0);
      expectCleared(env);
      expect(readFileSync(external, "utf8")).toBe("External file");
    }
  });

  test("unpushed edits warn before credentials, requests or mutations, even with telemetry enabled", async () => {
    const env = await withProfile(false);
    const server = api();
    const result = await datin(["logout"], server.respond, {
      env: { ...env, DATIN_TELEMETRY_DISABLED: "0" },
      openCredentialStore: () => {
        const refuse = async (): Promise<never> => {
          throw new Error("must not touch credentials before confirmation");
        };
        return { path: "/nowhere/credentials.json", get: refuse, set: refuse, delete: refuse };
      },
    });
    expect(result.exitCode).toBe(exitCodes.confirmation_required);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "confirmation_required",
        details: { unfinished: expect.arrayContaining(["unpushed profile draft"]) },
      },
      next: [{ command: "datin logout --yes" }],
    });
    expect(result.stderr).toContain("cannot be restored");
    expect(result.stdout).toBe("");
    expect(server.requests).toHaveLength(0);
    expect(readFileSync(profilePath(env), "utf8")).toBe(draft);
    expect(await openCredentialStore(env).get(origin)).toBe("saved-token");
    expect(existsSync(join(evidenceDir(env), "codex-history.md"))).toBe(true);
    expect(existsSync(join(configDir(env), "telemetry.json"))).toBe(false);
  });

  test("a fully synced profile logs out directly, preserving other credentials, preferences and unrelated files", async () => {
    const env = await withProfile(true);
    await openCredentialStore(env).set(staging, "staging-token");
    const telemetry = join(configDir(env), "telemetry.json");
    const preference = '{"installId":"test-install","enabled":false,"noticeVersion":2}';
    writeFileSync(telemetry, preference);
    const unrelated = join(env.DATIN_HOME, "notes.txt");
    writeFileSync(unrelated, "Keep this file");
    const server = api();
    const result = await datin(["logout"], server.respond, { env });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toEqual({
      logged_out: true,
      was_logged_in: true,
      revoked: true,
      local_data_cleared: true,
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers.get("authorization")).toBe("Bearer saved-token");
    expectCleared(env);
    expect(await openCredentialStore(env).get(origin)).toBeUndefined();
    expect(await openCredentialStore(env).get(staging)).toBe("staging-token");
    expect(readFileSync(telemetry, "utf8")).toBe(preference);
    expect(readFileSync(unrelated, "utf8")).toBe("Keep this file");
    const again = await datin(["logout"], server.respond, { env });
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(again.stdout).data.was_logged_in).toBe(false);
    expect(server.requests).toHaveLength(1);
  });

  test("the scheduled check's output files go too: they hold other people's cards and contacts", async () => {
    const env = await withProfile(true);
    const outputs = ["checks.log", "last-check.txt"].map((name) => join(env.DATIN_HOME, name));
    for (const file of outputs) writeFileSync(file, "telegram: @a_match");
    expect(logoutPaths(env).files).toEqual(expect.arrayContaining(outputs));
    const result = await datin(["logout"], api().respond, { env });
    expect(result.exitCode).toBe(0);
    for (const file of outputs) expect(existsSync(file)).toBe(false);
  });

  test("--yes discards unfinished work and cancels a pending sign-in even without a stored token", async () => {
    const env = await withProfile(false);
    await openCredentialStore(env).delete(origin);
    await pendingLogin.save(env, {
      apiUrl: origin,
      deviceCode: "device-secret",
      userCode: "CODE",
      verificationUri: origin,
      verificationUriComplete: origin,
      intervalSeconds: 5,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const server = api();
    const result = await datin(["logout", "--yes"], server.respond, { env });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ was_logged_in: false, local_data_cleared: true });
    expectCleared(env);
    expect(server.requests).toHaveLength(0);
    const wait = await datin(["login", "--wait"], server.respond, { env });
    expect(wait.exitCode).toBe(exitCodes.usage_error);
  });

  test("evidence without a saved profile and unfinished source scans each require confirmation", async () => {
    for (const kind of ["evidence", "scan"] as const) {
      const env = machine();
      if (kind === "evidence") {
        mkdirSync(evidenceDir(env), { recursive: true });
        writeFileSync(join(evidenceDir(env), "codex-history.md"), "Not yet used in a profile");
      } else {
        await recordDecision(env, "codex-history", { consent: "granted", consentVersion: 1 }, new Date());
      }
      const server = api();
      const result = await datin(["logout"], server.respond, { env });
      expect(result.exitCode).toBe(exitCodes.confirmation_required);
      expect(server.requests).toHaveLength(0);
    }
  });

  test("offline logout still clears locally and reports that revocation was not confirmed", async () => {
    const env = await withProfile(true);
    const result = await datin(
      ["logout"],
      () => {
        throw new Error("offline");
      },
      { env },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ data: { revoked: false, local_data_cleared: true } });
    expect(JSON.parse(result.stdout).summary).toContain("could not confirm");
    expectCleared(env);
  });

  test("a pending sign-in alone needs confirmation before it is cancelled", async () => {
    const env = machine();
    const server = api();
    await pendingLogin.save(env, {
      apiUrl: origin,
      deviceCode: "device-secret",
      userCode: "CODE",
      verificationUri: origin,
      verificationUriComplete: origin,
      intervalSeconds: 5,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await datin(["logout"], server.respond, { env });
    expect(result.exitCode).toBe(exitCodes.confirmation_required);
    expect(JSON.parse(result.stderr).error.details.unfinished).toEqual(["pending sign-in"]);
    expect(await pendingLogin.load(env)).toBeDefined();
    expect(result.stderr).not.toContain("device-secret");
    expect(server.requests).toHaveLength(0);
  });

  test("starting another scan after a synced profile makes that new work unfinished", async () => {
    const env = await withProfile(true);
    await recordDecision(env, "codex-history", { consent: "granted", consentVersion: 1 }, new Date());
    const result = await datin(["logout"], api().respond, { env });
    expect(result.exitCode).toBe(exitCodes.confirmation_required);
    expect(JSON.parse(result.stderr).error.details.unfinished).toEqual(["unfinished source scans"]);
    expect(await openCredentialStore(env).get(origin)).toBe("saved-token");
  });

  test("an expired sign-in is cleared without asking to discard already expired work", async () => {
    const env = machine();
    await pendingLogin.save(env, {
      apiUrl: origin,
      deviceCode: "expired-device-secret",
      userCode: "CODE",
      verificationUri: origin,
      verificationUriComplete: origin,
      intervalSeconds: 5,
      expiresAt: "2000-01-01T00:00:00Z",
    });
    const result = await datin(["logout"], api().respond, { env });
    expect(result.exitCode).toBe(0);
    expectCleared(env);
  });

  test("new evidence after a profile push warns until the reviewed profile is pushed again", async () => {
    const env = await withProfile(true);
    const push = (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/v1/profile");
      expect(request.method).toBe("PUT");
      return json({ ok: true, data: { version: 4, status: "active" } });
    };
    expect((await datin(["profile", "push"], push, { env })).exitCode).toBe(0);
    writeFileSync(join(evidenceDir(env), "codex-history.md"), "New findings awaiting review");
    const server = api();
    const unfinished = await datin(["logout"], server.respond, { env });
    expect(unfinished.exitCode).toBe(exitCodes.confirmation_required);
    expect(JSON.parse(unfinished.stderr).error.details.unfinished).toEqual([
      "local evidence not included in the last profile sync",
    ]);
    expect(server.requests).toHaveLength(0);
    expect((await datin(["profile", "push"], push, { env })).exitCode).toBe(0);
    expect((await datin(["logout"], server.respond, { env })).exitCode).toBe(0);
    expectCleared(env);
  });

  test("a filesystem cleanup failure produces a typed error, never a successful reset", async () => {
    const env = machine();
    mkdirSync(profilePath(env), { recursive: true });
    const result = await datin(["logout", "--yes"], api().respond, { env });
    expect(result.exitCode).toBe(exitCodes.local_state_error);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.details.path).toBe(profilePath(env));
  });

  test("--yes can clear corrupt state and removes an evidence symlink without following it", async () => {
    const env = machine();
    mkdirSync(env.DATIN_HOME, { recursive: true });
    writeFileSync(statePath(env), "not json");
    const outside = mkdtempSync(join(tmpdir(), "datin-external-evidence-"));
    writeFileSync(join(outside, "keep.md"), "External file");
    symlinkSync(outside, evidenceDir(env), "dir");
    const result = await datin(["logout", "--yes"], api().respond, { env });
    expect(result.exitCode).toBe(0);
    expectCleared(env);
    expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("External file");
  });

  test("a credential deletion failure is reported instead of claiming successful cleanup", async () => {
    const env = await withProfile(true);
    const result = await datin(["logout"], api().respond, {
      env,
      openCredentialStore: () => ({
        path: "/read-only/credentials.json",
        get: async () => "token",
        set: async () => {},
        delete: async () => {
          throw new Error("EACCES: permission denied, unlink '/read-only/credentials.json'");
        },
      }),
    });
    expect(result.exitCode).toBe(exitCodes.local_state_error);
    expect(JSON.parse(result.stderr).error.message).toContain("permission denied");
    expect(result.stdout).toBe("");
    expect(readFileSync(profilePath(env), "utf8")).toBe(draft);
  });
});
