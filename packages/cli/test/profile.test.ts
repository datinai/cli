import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SaveProfile } from "@datin/api-client";
import { exitCodes } from "../src/lib/errors.ts";
import { datin, json, source } from "./helpers.ts";

const TEMPLATE = "## name\n\n## about\n";

/** A fake API holding one profile with optimistic versioning, like the real one. */
function fakeApi() {
  const state: {
    markdown: string | undefined;
    version: number;
    contacts: string[];
    pushes: SaveProfile[];
  } = {
    markdown: undefined,
    version: 0,
    contacts: [],
    pushes: [],
  };
  const sources = [source("claude-history"), source("codex-history"), source("x", false)];
  const respond = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/sources") return json({ ok: true, data: { sources } });
    if (path === "/v1/profile/template") return json({ ok: true, data: { markdown: TEMPLATE, sections: [] } });
    if (path === "/v1/onboarding") {
      return json({
        ok: true,
        data: {
          profile: { exists: state.version > 0, version: state.version, status: state.version ? "active" : null },
          contacts: { kinds: state.contacts },
          consents: [],
        },
      });
    }
    if (path === "/v1/contacts") {
      state.contacts = Object.keys(await request.json());
      return json({ ok: true, data: {} });
    }
    if (path === "/v1/profile" && request.method === "GET") {
      return state.markdown === undefined
        ? json({ ok: false, error: { code: "not_found", message: "none", retryable: false } }, 404)
        : json({
            ok: true,
            data: {
              markdown: state.markdown,
              version: state.version,
              status: "active",
              updated_at: "2026-09-20T00:00:00Z",
            },
          });
    }
    if (path === "/v1/profile" && request.method === "PUT") {
      const body = (await request.json()) as SaveProfile;
      state.pushes.push(body);
      if (body.base_version !== state.version) {
        return json(
          {
            ok: false,
            error: {
              code: "profile_conflict",
              message: "stale",
              retryable: false,
              details: { current_version: state.version, current_markdown: state.markdown },
            },
          },
          409,
        );
      }
      state.markdown = body.markdown;
      state.version += 1;
      return json({ ok: true, data: { version: state.version, status: "active" } });
    }
    return json({}, 404);
  };
  return { respond, state, sources };
}

const machine = () => {
  const scratch = mkdtempSync(join(tmpdir(), "datin-profile-"));
  return { XDG_CONFIG_HOME: join(scratch, "config"), DATIN_HOME: join(scratch, "home"), DATIN_TOKEN: "tok" };
};
const fileOf = (env: { DATIN_HOME: string }) => join(env.DATIN_HOME, "datin.md");

describe("profile sync", () => {
  test("template --write creates the file once and never overwrites it", async () => {
    const env = machine();
    const api = fakeApi();
    expect(
      JSON.parse((await datin(["profile", "template", "--write"], api.respond, { env })).stdout).data.written,
    ).toBe(true);
    writeFileSync(fileOf(env), "## name\n\nAda\n");
    expect(
      JSON.parse((await datin(["profile", "template", "--write"], api.respond, { env })).stdout).data.written,
    ).toBe(false);
    expect(readFileSync(fileOf(env), "utf8")).toContain("Ada");
  });

  test("push sends the version it was based on, then remembers the new one", async () => {
    const env = machine();
    const api = fakeApi();
    await datin(["profile", "template", "--write"], api.respond, { env });
    writeFileSync(fileOf(env), "## name\n\nAda\n");
    await datin(["profile", "push", "--agent-model", "claude-fable-5-1"], api.respond, { env });
    writeFileSync(fileOf(env), "## name\n\nAda L.\n");
    await datin(["profile", "push"], api.respond, { env });
    expect(api.state.pushes.map((p) => [p.base_version, p.agent_model])).toEqual([
      [0, "claude-fable-5-1"],
      [1, undefined],
    ]);
  });

  test("a stray folder among the evidence files does not stop a push", async () => {
    const env = machine();
    const api = fakeApi();
    writeFileSync(fileOf(await ensureHome(env)), "## name\n\nAda\n");
    mkdirSync(join(env.DATIN_HOME, "evidence", "notes"), { recursive: true });
    expect((await datin(["profile", "push"], api.respond, { env })).exitCode).toBe(0);
  });

  test("an edit made elsewhere makes the next push a profile_conflict carrying the current text", async () => {
    const env = machine();
    const api = fakeApi();
    writeFileSync(fileOf(await ensureHome(env)), "## name\n\nAda\n");
    await datin(["profile", "push"], api.respond, { env });
    api.state.markdown = "## name\n\nAda (edited on the website)\n";
    api.state.version = 2;

    const result = await datin(["profile", "push"], api.respond, { env });
    expect(result.exitCode).toBe(exitCodes.profile_conflict);
    expect(JSON.parse(result.stderr).error.details.current_markdown).toContain("website");
  });

  test("pull refuses to overwrite unpushed local edits without --yes; diff names the section", async () => {
    const env = machine();
    const api = fakeApi();
    writeFileSync(fileOf(await ensureHome(env)), "## name\n\nAda\n\n## about\n\nhello\n");
    await datin(["profile", "push"], api.respond, { env });
    writeFileSync(fileOf(env), "## name\n\nAda\n\n## about\n\nhello, edited locally\n");

    const diff = JSON.parse((await datin(["profile", "diff"], api.respond, { env })).stdout).data;
    expect(diff.changed.map((c: { section: string }) => c.section)).toEqual(["about"]);

    const refused = await datin(["profile", "pull"], api.respond, { env });
    expect(refused.exitCode).toBe(exitCodes.confirmation_required);
    expect(readFileSync(fileOf(env), "utf8")).toContain("edited locally");

    expect((await datin(["profile", "pull", "--yes"], api.respond, { env })).exitCode).toBe(0);
    expect(readFileSync(fileOf(env), "utf8")).not.toContain("edited locally");
  });
});

describe("onboarding status", () => {
  const current = async (env: Record<string, string>, api: ReturnType<typeof fakeApi>) =>
    JSON.parse((await datin(["onboarding", "status"], api.respond, { env })).stdout).data.current;

  test("logged out and offline, it still reports; only the sources step cannot be judged", async () => {
    const { DATIN_TOKEN: _token, ...env } = machine();
    const result = await datin(
      ["onboarding", "status"],
      () => {
        throw new TypeError("fetch failed");
      },
      { env },
    );
    expect(result.exitCode).toBe(0);
    const steps = JSON.parse(result.stdout).data.steps as { id: string; state: string }[];
    expect(steps.find((step) => step.id === "sources")?.state).not.toBe("done");
  });

  test("walks model check → login → all sources → draft → push → contacts → schedule → recommendations → complete", async () => {
    const env = machine();
    const { DATIN_TOKEN: _token, ...loggedOut } = env;
    const api = fakeApi();
    const modelsApi = (request: Request) =>
      new URL(request.url).pathname === "/v1/models/check"
        ? json({
            ok: true,
            data: {
              model: "m",
              normalized: "m",
              provider: null,
              verdict: "unknown_provider",
              recommended: null,
              how_to_switch: null,
              advice: "",
            },
          })
        : api.respond(request);

    expect(await current(loggedOut, api)).toBe("model_check");
    await datin(["models"], modelsApi, { env: loggedOut });
    expect(await current(loggedOut, api)).toBe("model_check"); // listing alone is not a check
    await datin(["models", "check", "--model", "m"], modelsApi, { env: loggedOut });
    expect(await current(loggedOut, api)).toBe("login");
    expect(await current(env, api)).toBe("sources");
    await datin(["sources", "skip", "claude-history"], api.respond, { env });
    expect(await current(env, api)).toBe("sources");
    await datin(["sources", "consent", "codex-history", "--granted"], api.respond, { env });
    expect(await current(env, api)).toBe("sources");
    await datin(["sources", "done", "codex-history"], api.respond, { env });
    expect(await current(env, api)).toBe("draft");
    // New consent wording must reopen the step, even after a completed scan.
    api.sources[1] = source("codex-history", true, 2);
    expect(await current(env, api)).toBe("sources");
    await datin(["sources", "consent", "codex-history", "--declined"], api.respond, { env });
    expect(await current(env, api)).toBe("draft");

    writeFileSync(fileOf(await ensureHome(env)), "## name\n\nAda\n");
    expect(await current(env, api)).toBe("push");
    await datin(["profile", "push"], api.respond, { env });
    expect(await current(env, api)).toBe("contacts");
    // A newer server version invalidates the local push receipt, even if the local hash is unchanged.
    api.state.version += 1;
    expect(await current(env, api)).toBe("push");
    await datin(["profile", "pull"], api.respond, { env });
    expect(await current(env, api)).toBe("contacts");
    await datin(["contacts", "set", "--telegram", "@ada"], api.respond, { env });
    expect(await current(env, api)).toBe("schedule");
    expect((await datin(["schedule", "confirm", "--every", "3h"], api.respond, { env })).exitCode).toBe(2);
    expect(await current(env, api)).toBe("schedule");
    await datin(["schedule", "confirm", "--every", "3h", "--job", "test-scheduler-job"], api.respond, { env });
    expect(await current(env, api)).toBe("recommendations");
    const recsApi = (request: Request) =>
      new URL(request.url).pathname === "/v1/recs"
        ? json({ ok: true, data: { recommendations: [{ candidate_id: "u2" }], algorithm: "random" } })
        : api.respond(request);
    await datin(["recs", "list"], recsApi, { env });

    const done = JSON.parse((await datin(["onboarding", "status"], api.respond, { env })).stdout).data;
    expect(done.complete).toBe(true);
    expect(done.steps.find((s: { id: string }) => s.id === "sources").state).toBe("done");
    expect(done.steps.find((s: { id: string }) => s.id === "interview").state).toBe("unavailable");
  });
});

async function ensureHome<T extends { DATIN_HOME: string }>(env: T): Promise<T> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(env.DATIN_HOME, { recursive: true });
  return env;
}
