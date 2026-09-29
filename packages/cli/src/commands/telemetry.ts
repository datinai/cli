import type { Command } from "@commander-js/extra-typings";
import { describe, type Finish } from "../define-command.ts";
import { fromLocal } from "../lib/local.ts";
import { setTelemetry, telemetryStatus } from "../lib/telemetry.ts";

export function registerTelemetry(program: Command, finish: Finish): void {
  const telemetry = program
    .command("telemetry")
    .description("Anonymous usage data: command names, flag names and error codes; never values or anything about you");

  const status = (env: Readonly<Record<string, string | undefined>>) =>
    fromLocal(telemetryStatus(env), "read or change the telemetry setting").map((data) => ({
      data,
      summary: data.enabled ? "Anonymous usage data is on" : `Anonymous usage data is off (${data.disabled_by})`,
    }));

  describe(
    telemetry
      .command("status")
      .description("Whether usage data is sent, and what turned it off")
      .action(() => finish((context) => status(context.deps.env))),
    {
      examples: ["datin telemetry status --json"],
      errors: ["local_state_error"],
    },
  );

  for (const [name, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    describe(
      telemetry
        .command(name)
        .description(`Turn anonymous usage data ${enabled ? "on" : "off"} on this machine`)
        .action(() =>
          finish((context) =>
            fromLocal(setTelemetry(context.deps.env, enabled), "read or change the telemetry setting").andThen(() =>
              status(context.deps.env),
            ),
          ),
        ),
      { examples: [`datin telemetry ${name}`], errors: ["local_state_error"] },
    );
  }
}
