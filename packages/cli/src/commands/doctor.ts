import type { Command } from "@commander-js/extra-typings";
import { getHealth } from "@datin/api-client";
import { describe, type Finish } from "../define-command.ts";
import { okAsync } from "../lib/result.ts";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const MIN_NODE = [22, 12] as const;

function nodeCheck(version: string): Check {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return { name: "node", ok, detail: ok ? version : `${version} is older than ${MIN_NODE.join(".")}` };
}

export function registerDoctor(program: Command, finish: Finish): void {
  describe(
    program
      .command("doctor")
      .description("Check that this machine can run datin and reach the API")
      .action(() =>
        finish(
          (context) =>
            context.api
              .call((client) => getHealth({ client }))
              .map((): Check => ({ name: "api", ok: true, detail: context.apiUrl }))
              // A failed check is a finding to report, not a failed command.
              .orElse((error) => okAsync<Check>({ name: "api", ok: false, detail: `${error.code}: ${error.message}` }))
              .map((api) => {
                const runtime: Check = context.deps.bunVersion
                  ? { name: "bun", ok: true, detail: context.deps.bunVersion }
                  : nodeCheck(context.deps.nodeVersion);
                const checks = [runtime, api];
                const healthy = checks.every((check) => check.ok);
                return {
                  data: { healthy, version: context.deps.version, checks },
                  summary: healthy ? "Everything datin needs is in place" : "Some checks failed",
                };
              }),
          ({ data, summary }) =>
            [summary, ...data.checks.map((check) => `${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`)]
              .filter(Boolean)
              .join("\n"),
        ),
      ),
    { examples: ["datin doctor --json"], errors: [] },
  );
}
