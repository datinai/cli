import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Source } from "@datin/api-client";
import type { Deps } from "../src/context.ts";
import { openCredentialStore } from "../src/lib/credentials/store.ts";
import { run } from "../src/run.ts";

export interface Captured {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type Responder = (request: Request) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Runs the CLI in-process with a fake network, exactly as an agent would: no terminal, output piped. */
export async function datin(
  argv: string[],
  respond: Responder = () => json({}, 500),
  overrides: Partial<Deps> = {},
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  // Every run gets its own config directory unless the test passes one to share state between commands.
  const scratch = mkdtempSync(join(tmpdir(), "datin-test-"));
  // Usage reporting is off in tests unless a test turns it on, so fake APIs only see the calls under test.
  const env = {
    XDG_CONFIG_HOME: join(scratch, "config"),
    DATIN_HOME: join(scratch, "home"),
    DATIN_TELEMETRY_DISABLED: "1",
    ...overrides.env,
  };
  const exitCode = await run(argv, {
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
    stdoutIsTTY: false,
    stdinIsTTY: false,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => respond(new Request(input, init))) as typeof fetch,
    version: "0.0.0-test",
    nodeVersion: "v22.18.0",
    now: () => new Date(),
    sleep: async () => {},
    openBrowser: async () => {
      throw new Error("Unexpected browser launch in a CLI fixture");
    },
    openCredentialStore: () => openCredentialStore(env),
    ...overrides,
    env,
  });
  return { exitCode, stdout, stderr };
}

/** Synthetic catalogue entry; never reads local histories. */
export const source = (id: string, enabled = true, version = 1): Source => ({
  id,
  kind: id === "x" ? "connected" : "local",
  title: id,
  enabled,
  disabled_reason: enabled ? null : "switched_off",
  consent: {
    what: "Read your past conversations",
    why: "To draft your datin.md",
    goes_where: "Stays on your machine",
    version,
  },
});
