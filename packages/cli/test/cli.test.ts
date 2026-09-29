import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitCodes } from "../src/lib/errors.ts";
import { datin, json } from "./helpers.ts";

const models = {
  ok: true,
  data: { providers: [], unknown_provider: "Use your best model", applies_to: "Onboarding" },
  summary: "Compare your model",
};

describe("output contract", () => {
  test("success is exactly one JSON document on stdout and nothing on stderr", async () => {
    const result = await datin(["models"], () => json(models));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(models);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toBe("");
  });

  test("a server error keeps its code, goes to stderr, and sets that code's exit status", async () => {
    const envelope = {
      ok: false,
      error: {
        code: "source_disabled",
        message: "The X source is switched off",
        retryable: true,
        details: { source: "x" },
      },
    };
    const result = await datin(["models"], () => json(envelope, 503));
    expect(result.exitCode).toBe(exitCodes.source_disabled);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual(envelope);
  });

  test("an unreachable API is a retryable network_error", async () => {
    const result = await datin(["models"], () => {
      throw new TypeError("fetch failed");
    });
    expect(result.exitCode).toBe(exitCodes.network_error);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "network_error", retryable: true } });
  });

  test("an error body that is not our envelope is reported as internal_error, not trusted", async () => {
    const result = await datin(["models"], () => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(result.exitCode).toBe(exitCodes.internal_error);
    expect(JSON.parse(result.stderr).error.code).toBe("internal_error");
  });

  test("in a terminal the default is human text; --json forces JSON", async () => {
    const human = await datin(["models"], () => json(models), { stdoutIsTTY: true });
    expect(() => JSON.parse(human.stdout)).toThrow();
    const forced = await datin(["models", "--json"], () => json(models), { stdoutIsTTY: true });
    expect(JSON.parse(forced.stdout).ok).toBe(true);
  });
});

describe("usage errors", () => {
  test("an unknown command is a typed usage_error with exit code 2", async () => {
    const result = await datin(["modles"]);
    expect(result.exitCode).toBe(exitCodes.usage_error);
    const body = JSON.parse(result.stderr);
    expect(body.error.code).toBe("usage_error");
    expect(body.error.message).toContain("models"); // the suggestion
  });

  test("--help exits 0 and documents examples and error codes", async () => {
    const result = await datin(["models", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("datin models --json");
    expect(result.stdout).toContain("network_error");
  });
});

describe("self-description", () => {
  test("`commands` lists every command with its examples and errors", async () => {
    const result = await datin(["commands"]);
    const names = JSON.parse(result.stdout).data.commands.map((entry: { command: string }) => entry.command);
    expect(names).toEqual(
      expect.arrayContaining(["datin models", "datin models check", "datin doctor", "datin commands"]),
    );
  });

  test("`doctor` reports a failing API as a finding, not as a crash", async () => {
    const result = await datin(["doctor"], () => {
      throw new TypeError("fetch failed");
    });
    expect(result.exitCode).toBe(0);
    const { data } = JSON.parse(result.stdout);
    expect(data.healthy).toBe(false);
    expect(data.checks.find((check: { name: string }) => check.name === "api").ok).toBe(false);
  });

  test("the API URL can be overridden by flag or environment", async () => {
    const seen: string[] = [];
    const respond = (request: Request) => {
      seen.push(new URL(request.url).origin);
      return json(models);
    };
    await datin(["models", "--api-url", "http://localhost:8787"], respond);
    await datin(["models"], respond, { env: { DATIN_API_URL: "http://127.0.0.1:9999" } });
    await datin(["models"], respond);
    expect(seen).toEqual(["http://localhost:8787", "http://127.0.0.1:9999", "https://api.datinapp.com"]);
  });

  test("plain http is refused unless the API is on this machine, from the flag and the environment alike", async () => {
    const seen: string[] = [];
    const respond = (request: Request) => {
      seen.push(new URL(request.url).origin);
      return json(models);
    };
    for (const [argv, env] of [
      [["whoami", "--api-url", "http://api.example.com"], {}],
      [["whoami"], { DATIN_API_URL: "http://api.example.com" }],
      [["whoami"], { DATIN_API_URL: "not a url" }],
    ] as const) {
      const result = await datin([...argv], respond, { env: { ...env, DATIN_TOKEN: "tok_123" } });
      expect(result.exitCode).toBe(exitCodes.usage_error);
      expect(JSON.parse(result.stderr).error.code).toBe("usage_error");
    }
    const fromEnv = await datin(["whoami"], respond, { env: { DATIN_API_URL: "http://api.example.com" } });
    expect(JSON.parse(fromEnv.stderr).error.message).toContain("DATIN_API_URL");
    expect(seen).toEqual([]);

    await datin(["models", "--api-url", "http://[::1]:8787"], respond);
    await datin(["models"], respond, { env: { DATIN_API_URL: "https://staging.example.com" } });
    expect(seen).toEqual(["http://[::1]:8787", "https://staging.example.com"]);
  });
});

describe("things an agent gets wrong", () => {
  test("a group without a subcommand says which subcommands exist", async () => {
    const result = await datin(["profile"]);
    expect(result.exitCode).toBe(exitCodes.usage_error);
    const body = JSON.parse(result.stderr);
    expect(body.error.message).toContain("needs a subcommand");
    expect(body.error.details.subcommands).toEqual(expect.arrayContaining(["push", "pull", "diff"]));
    expect(result.stderr).not.toContain("outputHelp");
  });

  test("`datin` alone prints help and succeeds", async () => {
    const result = await datin([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: datin");
  });

  test("a malformed --api-url is a usage error, not a crash", async () => {
    const result = await datin(["whoami", "--api-url", "not a url"]);
    expect(result.exitCode).toBe(exitCodes.usage_error);
    expect(JSON.parse(result.stderr).error.code).toBe("usage_error");
  });

  test("a corrupted local file is a typed error that names the file", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const config = mkdtempSync(join(tmpdir(), "datin-corrupt-"));
    mkdirSync(join(config, "datin"), { recursive: true });
    writeFileSync(join(config, "datin", "credentials.json"), "{ not json");
    const result = await datin(["whoami"], undefined, { env: { XDG_CONFIG_HOME: config } });
    expect(result.exitCode).toBe(exitCodes.local_state_error);
    expect(JSON.parse(result.stderr).error.hint).toContain("~/.config/datin");
  });
});

describe("rate limits", () => {
  test("a short wait the API asks for is sat out once, with a note on stderr", async () => {
    let calls = 0;
    const paused: number[] = [];
    const result = await datin(
      ["models"],
      () =>
        ++calls === 1
          ? json(
              {
                ok: false,
                error: {
                  code: "rate_limited",
                  message: "slow down",
                  retryable: true,
                  details: { retry_after_seconds: 10 },
                },
              },
              429,
            )
          : json(models),
      { sleep: async (ms) => void paused.push(ms) },
    );
    expect(result.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect(paused).toEqual([10_000]);
    expect(JSON.parse(result.stdout)).toEqual(models);
    expect(JSON.parse(result.stderr)).toEqual({ event: "waiting", seconds: 10 });
  });

  test("a long wait is reported, not waited for", async () => {
    let calls = 0;
    const result = await datin(["models"], () => {
      calls++;
      return json(
        {
          ok: false,
          error: {
            code: "rate_limited",
            message: "tomorrow",
            retryable: true,
            details: { retry_after_seconds: 80_000 },
          },
        },
        429,
      );
    });
    expect(result.exitCode).toBe(exitCodes.rate_limited);
    expect(calls).toBe(1);
  });
});

describe("models check", () => {
  const verdict = {
    ok: true,
    data: {
      model: "claude-opus-5-5[1m]",
      normalized: "claude-opus-5-5",
      provider: "anthropic",
      verdict: "accepted",
      recommended: { id: "claude-fable-5-1", name: "Fable 5.1" },
      accepted: [{ id: "claude-opus-5-5", name: "Opus 5.5" }],
      minimum_effort: null,
      how_to_switch: "In Claude Code run /model fable",
      advice: "Works. Mention once that Fable 5.1 drafts a better profile",
    },
    summary: "Works. Mention once that Fable 5.1 drafts a better profile",
  };

  test("asks the API about the exact id, and only then counts the onboarding step as done", async () => {
    let asked: string | null | undefined;
    const home = { DATIN_HOME: mkdtempSync(join(tmpdir(), "datin-models-")) };
    const listing = await datin(["models"], () => json(models), { env: home });
    expect(listing.exitCode).toBe(0);
    expect(existsSync(join(home.DATIN_HOME, "state.json"))).toBe(false);

    const result = await datin(
      ["models", "check", "--model", "claude-opus-5-5[1m]"],
      (request) => {
        asked = new URL(request.url).searchParams.get("model");
        return json(verdict);
      },
      { env: home },
    );
    expect(result.exitCode).toBe(0);
    expect(asked).toBe("claude-opus-5-5[1m]");
    expect(JSON.parse(result.stdout).data.verdict).toBe("accepted");
    expect(JSON.parse(readFileSync(join(home.DATIN_HOME, "state.json"), "utf8"))).toMatchObject({
      modelChecked: true,
      agentModel: "claude-opus-5-5",
    });
  });

  test("takes either the model or, when the agent cannot see it, the provider", async () => {
    expect((await datin(["models", "check"])).exitCode).toBe(exitCodes.usage_error);
    expect((await datin(["models", "check", "--model", "m", "--provider", "openai"])).exitCode).toBe(
      exitCodes.usage_error,
    );
    expect((await datin(["models", "check", "--model", "m", "--effort", "turbo"])).exitCode).toBe(
      exitCodes.usage_error,
    );

    const queries: string[] = [];
    const home = { DATIN_HOME: mkdtempSync(join(tmpdir(), "datin-models-")) };
    const respond = (request: Request) => {
      queries.push(new URL(request.url).search);
      return json({ ...verdict, data: { ...verdict.data, model: "", normalized: "", verdict: "disclose" } });
    };
    expect((await datin(["models", "check", "--provider", "openai"], respond, { env: home })).exitCode).toBe(0);
    expect((await datin(["models", "check", "--model", "gpt-6-sol", "--effort", "high"], respond)).exitCode).toBe(0);
    expect(queries).toEqual(["?provider=openai", "?model=gpt-6-sol&effort=high"]);
    // Disclosing counts as the check; there is no model id to remember.
    const state = JSON.parse(readFileSync(join(home.DATIN_HOME, "state.json"), "utf8"));
    expect(state.modelChecked).toBe(true);
    expect(state.agentModel).toBeUndefined();
  });
});
