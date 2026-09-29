import { rm } from "node:fs/promises";
import { join } from "node:path";
import { datinHome, hashOf, profilePath, readProfileFile, readState, statePath } from "./home.ts";
import { evidenceDir, readDecisions, readEvidenceSnapshot, sourceStatePath } from "./local-sources.ts";
import { pendingLogin, pendingLoginPath } from "./pending-login.ts";
import { removeFile } from "./private-file.ts";

/**
 * Where the harness notes tell scheduled checks to write their output. It holds other people's cards and
 * their contacts, so it goes at logout with everything else Datin put here.
 */
const CHECK_OUTPUTS = ["checks.log", "last-check.txt"];

/** Explicit paths only: never remove DATIN_HOME or the config directory wholesale. */
export function logoutPaths(env: Readonly<Record<string, string | undefined>>) {
  return {
    files: [
      profilePath(env),
      statePath(env),
      sourceStatePath(env),
      pendingLoginPath(env),
      ...CHECK_OUTPUTS.map((name) => join(datinHome(env), name)),
    ],
    evidence: evidenceDir(env),
  };
}

/** Warn about work not yet saved, rather than every local cache left by completed onboarding. */
export async function unfinishedLogoutWork(
  env: Readonly<Record<string, string | undefined>>,
  now: Date,
): Promise<string[]> {
  const [draft, state, decisions, pending, evidence] = await Promise.all([
    readProfileFile(env),
    readState(env),
    readDecisions(env),
    pendingLogin.load(env),
    readEvidenceSnapshot(env),
  ]);
  const synced = draft !== undefined && hashOf(draft) === state.syncedHash;
  const unfinished: string[] = [];
  if (draft !== undefined && !synced) unfinished.push("unpushed profile draft");
  if (evidence.hasContent && evidence.hash !== state.syncedEvidenceHash)
    unfinished.push("local evidence not included in the last profile sync");
  if (Object.values(decisions).some((decision) => decision.consent === "granted" && decision.status === undefined))
    unfinished.push("unfinished source scans");
  if (pending && !(Date.parse(pending.expiresAt) <= now.getTime())) unfinished.push("pending sign-in");
  return unfinished;
}

export async function clearLogoutData(paths: ReturnType<typeof logoutPaths>): Promise<void> {
  for (const path of paths.files) await removeFile(path);
  // rm removes a symlink itself, without deleting the directory it points to.
  await rm(paths.evidence, { recursive: true, force: true });
}
