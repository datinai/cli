import { join } from "node:path";
import { configDir } from "../paths.ts";
import { readPrivateJson, removeFile, writePrivateJson } from "../private-file.ts";

/**
 * Where the login token lives: one owner-only file, the way Wrangler, Codex, Convex and Stripe keep theirs.
 * No OS keychain, so logging in never raises a system prompt about passwords. One token per API origin,
 * so a local or staging API never sees the production token.
 */
/** Logins are stored per API origin, so a local or staging API never sees another's token. */
export const loginAccount = (apiUrl: string) => new URL(apiUrl).origin;

export interface CredentialStore {
  /** The file, for `auth status` and for anyone wondering where their login is. */
  readonly path: string;
  get(account: string): Promise<string | undefined>;
  set(account: string, token: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export function openCredentialStore(env: Readonly<Record<string, string | undefined>>): CredentialStore {
  const path = join(configDir(env), "credentials.json");
  const readAll = async (): Promise<Record<string, string>> => {
    const value = await readPrivateJson(path);
    if (typeof value !== "object" || value === null) return {};
    return Object.fromEntries(
      Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
    );
  };
  return {
    path,
    get: async (account) => (await readAll())[account],
    set: async (account, token) => writePrivateJson(path, { ...(await readAll()), [account]: token }),
    delete: async (account) => {
      const all = await readAll();
      if (!Object.hasOwn(all, account)) return;
      const { [account]: _removed, ...rest } = all;
      if (Object.keys(rest).length === 0) await removeFile(path);
      else await writePrivateJson(path, rest);
    },
  };
}
