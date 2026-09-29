import { describe, expect, test } from "bun:test";
import { AGENT_IDS } from "../src/agents/instructions.gen.ts";
import { exitCodes } from "../src/lib/errors.ts";
import { datin, json } from "./helpers.ts";

describe("agent instructions", () => {
  test("every harness the user asked for is there, and each file covers the same ground", async () => {
    expect([...AGENT_IDS].sort()).toEqual(["claude", "codex", "grok", "hermes", "muse", "openclaw", "opencode", "pi"]);
    for (const id of AGENT_IDS) {
      const result = await datin(["agent", "instructions", id]);
      expect(result.exitCode).toBe(0);
      const { data } = JSON.parse(result.stdout) as { data: { agent: string; markdown: string } };
      expect(data.agent).toBe(id);
      for (const heading of [
        "## Asking the user",
        "## Your model",
        "## The recurring check",
        "## Skills",
        "## Showing people",
      ])
        expect(data.markdown).toContain(heading);
    }
  });

  test("an unknown harness is a usage error that lists the known ones", async () => {
    const result = await datin(["agent", "instructions", "emacs"]);
    expect(result.exitCode).toBe(exitCodes.usage_error);
    expect(JSON.parse(result.stderr).error.hint).toContain("claude");
  });

  test("the list is offline and needs no login", async () => {
    const result = await datin(["agent", "list"], () => {
      throw new Error("no network expected");
    });
    expect(JSON.parse(result.stdout).data.agents).toHaveLength(8);
  });
});

describe("feedback", () => {
  test("sends the message with where it came from, never anything else", async () => {
    let body: Record<string, unknown> | undefined;
    const result = await datin(
      ["feedback", "create", "--kind", "bug", "--message", "push said profile_conflict", "--agent", "claude"],
      async (request) => {
        body = (await request.json()) as Record<string, unknown>;
        return json({ ok: true, data: { id: "f1", acknowledgement: "email" }, summary: "Received" });
      },
      { env: { DATIN_TOKEN: "tok" } },
    );
    expect(result.exitCode).toBe(0);
    expect(body).toEqual({
      kind: "bug",
      message: "push said profile_conflict",
      cli_version: "0.0.0-test",
      os: process.platform,
      agent: "claude",
    });
  });

  test("needs a login and a known kind", async () => {
    expect((await datin(["feedback", "create", "--message", "hi"])).exitCode).toBe(exitCodes.auth_required);
    const kind = await datin(["feedback", "create", "--message", "hi", "--kind", "rant"], undefined, {
      env: { DATIN_TOKEN: "tok" },
    });
    expect(kind.exitCode).toBe(exitCodes.usage_error);
  });
});
