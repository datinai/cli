import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readPrivateJson, writePrivateFile, writePrivateJson } from "./private-file.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** `~/.datin` (or `$DATIN_HOME`): the working copy of datin.md and what the CLI remembers about it. */
export const datinHome = (env: Env) => env.DATIN_HOME || join(homedir(), ".datin");
export const profilePath = (env: Env) => join(datinHome(env), "datin.md");
export const statePath = (env: Env) => join(datinHome(env), "state.json");

export interface LocalState {
  /** Anonymous analytics scope for this onboarding attempt; cleared by logout. */
  readonly onboardingAttemptId: string | undefined;
  /** Server version the working copy was last in sync with; 0 when it was never pushed or pulled. */
  readonly version: number;
  /** Hash of the text at that moment, to tell "edited locally since" apart from "untouched". */
  readonly syncedHash: string | undefined;
  /** Evidence available when the local profile was last pushed after review. */
  readonly syncedEvidenceHash: string | undefined;
  readonly modelChecked: boolean;
  /** The agent's model as `models check` normalized it; the default for `--agent-model` on push. */
  readonly agentModel: string | undefined;
  readonly schedule: string | undefined;
  /** Scheduler job id or path, recorded only after the agent verifies the task exists. */
  readonly scheduleJob: string | undefined;
  /** At least one recommendation has been shown on this machine. */
  readonly recsSeen: boolean;
}

const EMPTY: LocalState = {
  onboardingAttemptId: undefined,
  version: 0,
  syncedHash: undefined,
  syncedEvidenceHash: undefined,
  modelChecked: false,
  agentModel: undefined,
  schedule: undefined,
  scheduleJob: undefined,
  recsSeen: false,
};

export const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

export async function readState(env: Env): Promise<LocalState> {
  const value = await readPrivateJson(statePath(env));
  if (typeof value !== "object" || value === null) return EMPTY;
  const v = value as Record<string, unknown>;
  return {
    onboardingAttemptId: typeof v.onboardingAttemptId === "string" ? v.onboardingAttemptId : undefined,
    version: typeof v.version === "number" ? v.version : 0,
    syncedHash: typeof v.syncedHash === "string" ? v.syncedHash : undefined,
    syncedEvidenceHash: typeof v.syncedEvidenceHash === "string" ? v.syncedEvidenceHash : undefined,
    modelChecked: v.modelChecked === true,
    agentModel: typeof v.agentModel === "string" ? v.agentModel : undefined,
    schedule: typeof v.schedule === "string" ? v.schedule : undefined,
    scheduleJob: typeof v.scheduleJob === "string" && v.scheduleJob.trim() ? v.scheduleJob : undefined,
    recsSeen: v.recsSeen === true,
  };
}

export async function updateState(env: Env, change: Partial<LocalState>): Promise<LocalState> {
  const next = { ...(await readState(env)), ...change };
  await writePrivateJson(statePath(env), next);
  return next;
}

export async function readProfileFile(env: Env): Promise<string | undefined> {
  try {
    return await readFile(profilePath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeProfileFile(env: Env, markdown: string): Promise<void> {
  await writePrivateFile(profilePath(env), markdown);
}

/** Section bodies by heading, without validating anything; enough to compare two copies section by section. */
export function sectionsOf(markdown: string): Map<string, string> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)?.[1]?.toLowerCase();
    if (heading !== undefined) {
      current = [];
      sections.set(heading, current);
    } else current?.push(line);
  }
  return new Map([...sections].map(([heading, lines]) => [heading, lines.join("\n").trim()]));
}
