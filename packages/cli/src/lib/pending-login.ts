import { join } from "node:path";
import { configDir } from "./paths.ts";
import { readPrivateJson, removeFile, writePrivateJson } from "./private-file.ts";

/** A login that was started but not finished, kept so `login --wait` can run as a separate command. */
export interface PendingLogin {
  readonly apiUrl: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly intervalSeconds: number;
  readonly expiresAt: string;
}

export const pendingLoginPath = (env: Readonly<Record<string, string | undefined>>) =>
  join(configDir(env), "pending-login.json");

function isPendingLogin(value: unknown): value is PendingLogin {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.apiUrl === "string" &&
    typeof v.deviceCode === "string" &&
    typeof v.userCode === "string" &&
    typeof v.verificationUri === "string" &&
    typeof v.verificationUriComplete === "string" &&
    typeof v.intervalSeconds === "number" &&
    typeof v.expiresAt === "string"
  );
}

export const pendingLogin = {
  save: (env: Readonly<Record<string, string | undefined>>, login: PendingLogin) =>
    writePrivateJson(pendingLoginPath(env), login),
  load: async (env: Readonly<Record<string, string | undefined>>): Promise<PendingLogin | undefined> => {
    const value = await readPrivateJson(pendingLoginPath(env));
    return isPendingLogin(value) ? value : undefined;
  },
  clear: (env: Readonly<Record<string, string | undefined>>) => removeFile(pendingLoginPath(env)),
};
