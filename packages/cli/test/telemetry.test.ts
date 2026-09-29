import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelemetryEvent } from "@datin/api-client";
import { datin, json } from "./helpers.ts";

function recorder() {
  const events: TelemetryEvent[] = [];
  const respond = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/t") {
      events.push(await request.json());
      return json({ ok: true, data: { accepted: true } });
    }
    if (path === "/v1/models") return json({ ok: true, data: { providers: [], unknown_provider: "", applies_to: "" } });
    if (path === "/v1/models/check")
      return json({
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
      });
    return json({ ok: false, error: { code: "auth_required", message: "no", retryable: false } }, 401);
  };
  return { events, respond };
}

const machine = (extra: Record<string, string | undefined> = {}) => {
  const scratch = mkdtempSync(join(tmpdir(), "datin-telemetry-"));
  return {
    XDG_CONFIG_HOME: join(scratch, "config"),
    DATIN_HOME: join(scratch, "home"),
    DATIN_TELEMETRY_DISABLED: "",
    ...extra,
  };
};

describe("anonymous usage data", () => {
  test("the first run only shows the notice; later runs report names, never values", async () => {
    const env = machine();
    const api = recorder();

    const first = await datin(["models"], api.respond, { env });
    expect(first.stderr).toContain("datin telemetry disable");
    expect(api.events).toHaveLength(0);

    await datin(["whoami", "--token", "super-secret-token", "--json"], api.respond, { env });
    expect(api.events).toHaveLength(1);
    expect(api.events[0]).toMatchObject({
      command: "whoami",
      flags: ["json", "token"],
      ok: false,
      error_code: "auth_required",
    });
    expect(JSON.stringify(api.events[0])).not.toContain("super-secret-token");

    await datin(["nonsense"], api.respond, { env });
    expect(api.events[1]).toMatchObject({ command: "(not recognised)", ok: false, error_code: "usage_error" });
    expect(api.events[1]?.install_id).toBe(api.events[0]?.install_id);
  });

  test("completed steps report immediately, share an attempt across calls, and start fresh after logout", async () => {
    const env = machine();
    const api = recorder();
    await datin(["models"], api.respond, { env }); // notice, no event
    await datin(["models", "check", "--model", "m"], api.respond, { env });
    const first = api.events.at(-1);
    expect(first?.onboarding_steps).toEqual(["model_check"]);
    expect(first?.onboarding_attempt_id).toBeString();
    await datin(["schedule", "confirm", "--every", "3h", "--job", "private-task-id"], api.respond, { env });
    expect(api.events.at(-1)?.onboarding_steps).toEqual(["schedule"]);
    expect(api.events.at(-1)?.onboarding_attempt_id).toBe(first?.onboarding_attempt_id);
    expect(JSON.stringify(api.events)).not.toContain("private-task-id");
    await datin(["logout", "--yes"], api.respond, { env });
    expect(api.events.at(-1)?.onboarding_attempt_id).toBeUndefined();
    await datin(["models", "check", "--model", "m"], api.respond, { env });
    expect(api.events.at(-1)?.install_id).toBe(first?.install_id);
    expect(api.events.at(-1)?.onboarding_attempt_id).not.toBe(first?.onboarding_attempt_id);
  });

  test("a notice that now covers more is shown again; the attempt id rides only on onboarding steps", async () => {
    const env = machine();
    const api = recorder();
    mkdirSync(join(env.XDG_CONFIG_HOME, "datin"), { recursive: true });
    writeFileSync(
      join(env.XDG_CONFIG_HOME, "datin", "telemetry.json"),
      '{"installId":"old-install","enabled":true,"noticeShown":true}',
    );
    const first = await datin(["models"], api.respond, { env });
    expect(first.stderr).toContain("onboarding progress");
    expect(api.events).toHaveLength(0);

    await datin(["models", "check", "--model", "m"], api.respond, { env });
    expect(api.events.at(-1)?.onboarding_attempt_id).toBeString();
    await datin(["models"], api.respond, { env });
    expect(api.events.at(-1)?.onboarding_attempt_id).toBeUndefined();
  });

  test("DO_NOT_TRACK, DATIN_TELEMETRY_DISABLED, CI and `telemetry disable` each send nothing", async () => {
    const switches: Record<string, string>[] = [
      { DO_NOT_TRACK: "1" },
      { DATIN_TELEMETRY_DISABLED: "1" },
      { CI: "true" },
    ];
    for (const extra of switches) {
      const api = recorder();
      const env = machine(extra);
      await datin(["models"], api.respond, { env });
      await datin(["models"], api.respond, { env });
      expect(api.events).toHaveLength(0);
    }

    const env = machine();
    const api = recorder();
    await datin(["models"], api.respond, { env }); // notice
    await datin(["telemetry", "disable"], api.respond, { env });
    await datin(["models"], api.respond, { env });
    expect(api.events).toHaveLength(0);
    expect(JSON.parse((await datin(["telemetry", "status"], api.respond, { env })).stdout).data).toMatchObject({
      enabled: false,
      disabled_by: "datin telemetry disable",
    });
  });

  test("a telemetry endpoint that hangs or fails never changes the command's result", async () => {
    const env = machine();
    const respond = async (request: Request) =>
      new URL(request.url).pathname === "/v1/t"
        ? Promise.reject(new TypeError("down"))
        : json({ ok: true, data: { providers: [], unknown_provider: "", applies_to: "" } });
    await datin(["models"], respond, { env });
    const result = await datin(["models"], respond, { env });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });
});

describe("sources", () => {
  test("connect x points at the website next to the API, and refuses unknown sources", async () => {
    const result = await datin(["sources", "connect", "x"]);
    expect(JSON.parse(result.stdout).data.url).toBe("https://datinapp.com/app/connections");
    expect((await datin(["sources", "connect", "myspace"])).exitCode).toBe(2);
  });

  test("fetch x passes the server's typed refusals through with their exit codes", async () => {
    const disabled = {
      ok: false,
      error: {
        code: "source_disabled",
        message: "off",
        retryable: true,
        details: { source: "x", reason: "not_configured" },
      },
    };
    const result = await datin(["sources", "fetch", "x"], () => json(disabled, 503), { env: { DATIN_TOKEN: "tok" } });
    expect(result.exitCode).toBe(11);
    expect(JSON.parse(result.stderr).error.details.reason).toBe("not_configured");
  });
});
