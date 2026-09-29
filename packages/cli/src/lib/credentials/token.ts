import type { CredentialStore } from "./store.ts";

export type TokenSource = "flag" | "env" | "file" | "none";

export interface ResolvedToken {
  readonly token: string | undefined;
  readonly source: TokenSource;
}

/** `--token`, then `DATIN_TOKEN`, then the stored login. */
export async function resolveToken(
  input: { flag: string | undefined; env: Readonly<Record<string, string | undefined>>; account: string },
  store: CredentialStore,
): Promise<ResolvedToken> {
  if (input.flag) return { token: input.flag, source: "flag" };
  if (input.env.DATIN_TOKEN) return { token: input.env.DATIN_TOKEN, source: "env" };
  const token = await store.get(input.account);
  return token ? { token, source: "file" } : { token: undefined, source: "none" };
}
