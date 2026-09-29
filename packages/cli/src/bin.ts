#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { version } from "../package.json" with { type: "json" };
import { openBrowser } from "./lib/browser.ts";
import { openCredentialStore } from "./lib/credentials/store.ts";
import { run } from "./run.ts";

enableCompileCache();

try {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutIsTTY: process.stdout.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    env: process.env,
    fetch: globalThis.fetch,
    version,
    nodeVersion: process.version,
    bunVersion: process.versions.bun,
    now: () => new Date(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    openBrowser,
    openCredentialStore: () => openCredentialStore(process.env),
  });
} catch (error) {
  // Reaching here is a bug in datin, not something the user did.
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: { code: "internal_error", message: error instanceof Error ? error.message : String(error), retryable: false } })}\n`,
  );
  process.exitCode = 1;
}
