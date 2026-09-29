import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCredentialStore } from "../src/lib/credentials/store.ts";
import { exitCodes } from "../src/lib/errors.ts";
import { datin, json } from "./helpers.ts";

const started = {
  ok: true,
  data: {
    device_code: "secret-device-code",
    user_code: "WDJB-MJHT",
    verification_uri: "https://datinapp.com/device",
    verification_uri_complete: "https://datinapp.com/device?user_code=WDJB-MJHT",
    expires_in: 300,
    interval: 5,
  },
};
const pending = {
  ok: false,
  error: { code: "login_pending", message: "Not confirmed yet", retryable: true, details: { interval: 5 } },
};
const me = { ok: true, data: { id: "u1", name: "Ada", email: "ada@example.com" } };

/** A fake API where the user confirms after `pollsBeforeApproval` polls. */
function fakeApi(pollsBeforeApproval: number) {
  let polls = 0;
  const seen: { path: string; authorization: string | null }[] = [];
  const respond = async (request: Request) => {
    const path = new URL(request.url).pathname;
    seen.push({ path, authorization: request.headers.get("authorization") });
    if (path === "/v1/auth/device") return json(started);
    if (path === "/v1/auth/device/token") {
      return polls++ < pollsBeforeApproval
        ? json(pending, 400)
        : json({ ok: true, data: { token: "tok_123", expires_in: 3600 } });
    }
    if (path === "/v1/me") {
      return request.headers.get("authorization") === "Bearer tok_123"
        ? json(me)
        : json({ ok: false, error: { code: "auth_required", message: "no", retryable: false } }, 401);
    }
    if (path === "/v1/auth/logout") return json({ ok: true, data: { logged_out: true } });
    return json({}, 404);
  };
  return { respond, seen };
}

const home = () => ({ XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "datin-auth-")) });

/** A store that fails the test if anything reads or writes the login. */
const untouchable = () => {
  const refuse = async (): Promise<never> => {
    throw new Error("must not touch the stored login");
  };
  return { path: "/nowhere/credentials.json", get: refuse, set: refuse, delete: refuse };
};

describe("already logged in", () => {
  test("login --no-wait with a working login is a no-op: no device code for the user", async () => {
    const api = fakeApi(0);
    const result = await datin(["login", "--no-wait"], api.respond, { env: { ...home(), DATIN_TOKEN: "tok_123" } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ logged_in: true, already: true, user: { name: "Ada" } });
    expect(api.seen.map((request) => request.path)).not.toContain("/v1/auth/device");
  });

  test("a dead token still starts a fresh login", async () => {
    const api = fakeApi(0);
    const result = await datin(["login", "--no-wait"], api.respond, { env: { ...home(), DATIN_TOKEN: "expired" } });
    expect(JSON.parse(result.stdout).data.user_code).toBe("WDJB-MJHT");
  });
});

describe("token file", () => {
  test("login keeps the token in an owner-only file, says where, and prints no notice", async () => {
    const env = home();
    const api = fakeApi(0);
    expect((await datin(["login", "--no-wait"], api.respond, { env })).exitCode).toBe(0);
    const result = await datin(["login", "--wait"], api.respond, { env });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const path = join(env.XDG_CONFIG_HOME, "datin", "credentials.json");
    expect(JSON.parse(result.stdout).data.stored_in).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(env.XDG_CONFIG_HOME, "datin")).mode & 0o777).toBe(0o700);
    expect(await openCredentialStore(env).get("https://api.datinapp.com")).toBe("tok_123");

    const status = await datin(["auth", "status"], api.respond, { env });
    expect(JSON.parse(status.stdout).data).toMatchObject({ logged_in: true, token_source: "file" });
    expect(status.stdout).not.toContain("tok_123");
  });

  test("public commands and explicit tokens never read the stored login", async () => {
    const openCredentialStore = untouchable;
    for (const args of [["commands"], ["agent", "instructions", "codex"], ["whoami", "--token", "tok_123"]]) {
      const result = await datin(args, fakeApi(0).respond, { openCredentialStore });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    }
    const result = await datin(["whoami"], fakeApi(0).respond, {
      openCredentialStore,
      env: { DATIN_TOKEN: "tok_123" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("login in two steps, the way an agent does it", () => {
  test("--no-wait prints the code and link and never the polling secret; --wait finishes and stores the token", async () => {
    const env = home();
    const api = fakeApi(2);

    const first = await datin(["login", "--no-wait"], api.respond, { env });
    expect(first.exitCode).toBe(0);
    const body = JSON.parse(first.stdout);
    expect(body.data.user_code).toBe("WDJB-MJHT");
    expect(body.next[0].command).toBe("datin login --wait");
    expect(first.stdout).not.toContain("secret-device-code");

    const second = await datin(["login", "--wait"], api.respond, { env });
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      ok: true,
      data: { logged_in: true, user: { name: "Ada" }, stored_in: expect.stringMatching(/credentials\.json$/) },
    });

    const who = await datin(["whoami"], api.respond, { env });
    expect(JSON.parse(who.stdout).data.email).toBe("ada@example.com");

    const mode = statSync(join(env.XDG_CONFIG_HOME, "datin", "credentials.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("--wait with a timeout stops as login_pending and can be resumed", async () => {
    const env = home();
    const api = fakeApi(1);
    await datin(["login", "--no-wait"], api.respond, { env });

    const impatient = await datin(["login", "--wait", "--timeout", "1"], api.respond, { env });
    expect(impatient.exitCode).toBe(exitCodes.login_pending);
    expect(JSON.parse(impatient.stderr)).toMatchObject({
      error: { code: "login_pending", retryable: true },
      next: [{ command: "datin login --wait" }],
    });

    const resumed = await datin(["login", "--wait"], api.respond, { env });
    expect(resumed.exitCode).toBe(0);
  });

  test("--wait without a started login is a usage error that says how to start one", async () => {
    const result = await datin(["login", "--wait"], fakeApi(0).respond, { env: home() });
    expect(result.exitCode).toBe(exitCodes.usage_error);
    expect(JSON.parse(result.stderr).next[0].command).toContain("--no-wait");
  });
});

describe("plain login", () => {
  test("announces the code on stderr and ends with one JSON result on stdout", async () => {
    const result = await datin(["login"], fakeApi(1).respond, { env: home() });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stderr.trim().split("\n")[0] ?? "")).toMatchObject({
      event: "login_started",
      user_code: "WDJB-MJHT",
    });
    expect(JSON.parse(result.stdout).data.logged_in).toBe(true);
  });
});

describe("token precedence and status", () => {
  test("--token beats DATIN_TOKEN, which beats the stored login", async () => {
    const env = home();
    const api = fakeApi(0);
    await datin(["login"], api.respond, { env });

    await datin(["whoami", "--token", "from_flag"], api.respond, { env: { ...env, DATIN_TOKEN: "from_env" } });
    await datin(["whoami"], api.respond, { env: { ...env, DATIN_TOKEN: "from_env" } });
    await datin(["whoami"], api.respond, { env });
    const sent = api.seen
      .filter((call) => call.path === "/v1/me")
      .slice(-3)
      .map((call) => call.authorization);
    expect(sent).toEqual(["Bearer from_flag", "Bearer from_env", "Bearer tok_123"]);
  });

  test("whoami without a login fails with auth_required; auth status reports it without failing", async () => {
    const env = home();
    const who = await datin(["whoami"], fakeApi(0).respond, { env });
    expect(who.exitCode).toBe(exitCodes.auth_required);

    const status = await datin(["auth", "status"], fakeApi(0).respond, { env });
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).data).toMatchObject({ logged_in: false, token_source: "none" });
  });

  test("logout revokes on the server and forgets the token locally", async () => {
    const env = home();
    const api = fakeApi(0);
    await datin(["login"], api.respond, { env });
    const out = await datin(["logout"], api.respond, { env });
    expect(JSON.parse(out.stdout).data).toEqual({
      logged_out: true,
      was_logged_in: true,
      revoked: true,
      local_data_cleared: true,
    });
    expect((await datin(["whoami"], api.respond, { env })).exitCode).toBe(exitCodes.auth_required);
  });

  test("login reports the account it just stored, even with DATIN_TOKEN naming another", async () => {
    const env = home();
    const result = await datin(["login"], fakeApi(0).respond, { env: { ...env, DATIN_TOKEN: "someone_else" } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.user).toMatchObject({ name: "Ada" });
    expect(await openCredentialStore(env).get("https://api.datinapp.com")).toBe("tok_123");
  });

  test("logout with DATIN_TOKEN also revokes and deletes the stored login", async () => {
    const env = home();
    const api = fakeApi(0);
    await datin(["login"], api.respond, { env });
    const out = await datin(["logout"], api.respond, { env: { ...env, DATIN_TOKEN: "from_env" } });
    expect(JSON.parse(out.stdout).data).toMatchObject({ logged_out: true, was_logged_in: true, revoked: true });
    const revoked = api.seen.filter((call) => call.path === "/v1/auth/logout").map((call) => call.authorization);
    expect(revoked.sort()).toEqual(["Bearer from_env", "Bearer tok_123"]);
    expect(await openCredentialStore(env).get("https://api.datinapp.com")).toBeUndefined();
    expect((await datin(["whoami"], api.respond, { env })).exitCode).toBe(exitCodes.auth_required);
  });
});
