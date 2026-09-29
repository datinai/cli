import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { join } from "node:path";
import { type Client, type OnboardingStep, sendTelemetry } from "@datin/api-client";
import type { Deps } from "../context.ts";
import { readState, updateState } from "./home.ts";
import { configDir } from "./paths.ts";
import { readPrivateJson, writePrivateJson } from "./private-file.ts";

type Env = Readonly<Record<string, string | undefined>>;

interface TelemetryConfig {
  readonly installId: string;
  readonly enabled: boolean;
  /** Which wording of the notice the user has seen; a wider scope is announced again. */
  readonly noticeVersion: number;
}

/** Bump when the notice starts covering something new. 1 had no onboarding progress. */
const NOTICE_VERSION = 2;

const configPath = (env: Env) => join(configDir(env), "telemetry.json");

async function readConfig(env: Env): Promise<TelemetryConfig | undefined> {
  const value = await readPrivateJson(configPath(env));
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  return typeof v.installId === "string"
    ? {
        installId: v.installId,
        enabled: v.enabled !== false,
        noticeVersion: typeof v.noticeVersion === "number" ? v.noticeVersion : v.noticeShown === true ? 1 : 0,
      }
    : undefined;
}

const isSet = (value: string | undefined) =>
  value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

/** Why telemetry is off for this run, or undefined when it is on. Environment switches win over the saved choice. */
export function disabledBy(env: Env, config: TelemetryConfig | undefined): string | undefined {
  if (isSet(env.DATIN_TELEMETRY_DISABLED)) return "DATIN_TELEMETRY_DISABLED";
  if (isSet(env.DO_NOT_TRACK)) return "DO_NOT_TRACK";
  if (isSet(env.CI)) return "CI";
  if (config?.enabled === false) return "datin telemetry disable";
  return undefined;
}

export async function telemetryStatus(env: Env) {
  const config = await readConfig(env);
  const reason = disabledBy(env, config);
  return { enabled: reason === undefined, disabled_by: reason ?? null, install_id: config?.installId ?? null };
}

export async function setTelemetry(env: Env, enabled: boolean): Promise<void> {
  const config = await readConfig(env);
  await writePrivateJson(configPath(env), {
    installId: config?.installId ?? randomUUID(),
    enabled,
    noticeVersion: NOTICE_VERSION,
  });
}

export interface CommandRun {
  readonly onboarding?: OnboardingStep[];
  readonly command: string;
  /** Names only. Flag values never leave the machine. */
  readonly flags: string[];
  readonly ok: boolean;
  readonly errorCode: string | undefined;
  readonly durationMs: number;
}

const NOTICE =
  "datin collects anonymous usage data (command names, flag names, error codes and onboarding progress; never flag values, account identity or profile content).\n" +
  "Turn it off with `datin telemetry disable`, DATIN_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1.\n";

async function onboardingAttempt(env: Env): Promise<string> {
  const { onboardingAttemptId } = await readState(env);
  if (onboardingAttemptId) return onboardingAttemptId;
  const fresh = randomUUID();
  await updateState(env, { onboardingAttemptId: fresh });
  return fresh;
}

/** Best effort and bounded: a slow or failing report never changes what the command did or how it exits. */
export async function report(deps: Deps, client: Client, run: CommandRun): Promise<void> {
  try {
    const existing = await readConfig(deps.env);
    if (disabledBy(deps.env, existing)) return;
    const config = existing ?? { installId: randomUUID(), enabled: true, noticeVersion: 0 };
    if (config.noticeVersion < NOTICE_VERSION) {
      deps.stderr.write(NOTICE);
      await writePrivateJson(configPath(deps.env), { ...config, noticeVersion: NOTICE_VERSION });
      return; // the run that shows the notice is not reported, so nobody is counted before being told
    }
    // The attempt id travels only with onboarding steps, never with unrelated commands.
    const attemptId = run.onboarding ? await onboardingAttempt(deps.env) : undefined;
    await sendTelemetry({
      client,
      // Reporting waits at most this long before the command exits; a slow network must not make datin feel slow.
      signal: AbortSignal.timeout(800),
      body: {
        install_id: config.installId,
        ...(attemptId && { onboarding_attempt_id: attemptId }),
        ...(run.onboarding && { onboarding_steps: run.ok ? run.onboarding : [] }),
        command: run.command,
        flags: run.flags,
        ok: run.ok,
        ...(run.errorCode && { error_code: run.errorCode }),
        duration_ms: run.durationMs,
        cli_version: deps.version,
        os: platform(),
        node: deps.nodeVersion,
      },
    });
  } catch {
    // telemetry must never be the reason a command fails
  }
}
