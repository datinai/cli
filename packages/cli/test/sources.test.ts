import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitCodes } from "../src/lib/errors.ts";
import { datin, json, source } from "./helpers.ts";

const api = (sources: ReturnType<typeof source>[]) => (request: Request) =>
  new URL(request.url).pathname === "/v1/sources" ? json({ ok: true, data: { sources } }) : json({}, 404);

function machine() {
  const scratch = mkdtempSync(join(tmpdir(), "datin-sources-"));
  const claude = join(scratch, "claude");
  mkdirSync(join(claude, "projects", "-Users-me-app"), { recursive: true });
  writeFileSync(
    join(claude, "projects", "-Users-me-app", "s1.jsonl"),
    '{"type":"user","message":{"content":"PRIVATE TEXT"}}\n',
  );
  writeFileSync(join(claude, "history.jsonl"), '{"display":"PRIVATE PROMPT"}\n');
  writeFileSync(join(claude, "projects", "auth.json"), "{}");
  return { XDG_CONFIG_HOME: join(scratch, "config"), DATIN_HOME: join(scratch, "home"), CLAUDE_CONFIG_DIR: claude };
}

describe("local sources are gated by the user's recorded yes", () => {
  test("detect and prompt refuse with consent_required, and the refusal carries what, why and where it goes", async () => {
    const env = machine();
    for (const command of ["detect", "prompt", "done"]) {
      const result = await datin(["sources", command, "claude-history"], api([source("claude-history")]), { env });
      expect(result.exitCode).toBe(exitCodes.consent_required);
      const body = JSON.parse(result.stderr);
      expect(body.error.details.consent).toMatchObject({
        what: expect.any(String),
        why: expect.any(String),
        goes_where: expect.any(String),
      });
      expect(body.next[0].command).toBe("datin sources consent claude-history --granted");
    }
  });

  test("after a yes, detect measures the folder without ever printing what is in the files", async () => {
    const env = machine();
    const respond = api([source("claude-history")]);
    await datin(["sources", "consent", "claude-history", "--granted"], respond, { env });

    const result = await datin(["sources", "detect", "claude-history"], respond, { env });
    const { data } = JSON.parse(result.stdout);
    expect(data).toMatchObject({ present: true, files: 1 }); // auth.json is skipped
    expect(data.start_with[0]).toEndWith("history.jsonl");
    expect(result.stdout).not.toContain("PRIVATE");

    const prompt = JSON.parse((await datin(["sources", "prompt", "claude-history"], respond, { env })).stdout).data;
    expect(prompt.evidence_path).toEndWith("evidence/claude-history.md");
    expect(prompt.prompt).toContain("Do not upload raw history to datin");
  });

  test("a no is remembered and keeps the source closed", async () => {
    const env = machine();
    const respond = api([source("claude-history")]);
    await datin(["sources", "consent", "claude-history", "--declined"], respond, { env });
    const result = await datin(["sources", "detect", "claude-history"], respond, { env });
    expect(result.exitCode).toBe(exitCodes.consent_required);
    expect(JSON.parse(result.stderr).error.message).toContain("said no");
  });

  test("changed wording asks again; a source the team switched off is source_disabled even with a yes", async () => {
    const env = machine();
    await datin(["sources", "consent", "claude-history", "--granted"], api([source("claude-history", true, 1)]), {
      env,
    });
    expect(
      (await datin(["sources", "detect", "claude-history"], api([source("claude-history", true, 2)]), { env }))
        .exitCode,
    ).toBe(exitCodes.consent_required);
    expect(
      (await datin(["sources", "detect", "claude-history"], api([source("claude-history", false, 1)]), { env }))
        .exitCode,
    ).toBe(exitCodes.source_disabled);
  });

  test("consent needs exactly one answer and a known source", async () => {
    const respond = api([source("claude-history")]);
    expect((await datin(["sources", "consent", "claude-history"], respond)).exitCode).toBe(exitCodes.usage_error);
    expect((await datin(["sources", "consent", "myspace", "--granted"], respond)).exitCode).toBe(exitCodes.usage_error);
  });
});
