import type { OnboardingStep } from "@datin/api-client";
import type { Api } from "./lib/api.ts";
import type { CredentialStore } from "./lib/credentials/store.ts";
import type { ResolvedToken } from "./lib/credentials/token.ts";
import type { DatinError } from "./lib/errors.ts";
import type { OutputMode, Writer } from "./lib/output.ts";
import type { ResultAsync } from "./lib/result.ts";

/** Everything from the outside world, injected so commands can be run in-process by tests. */
export interface Deps {
  readonly stdout: Writer;
  readonly stderr: Writer;
  readonly stdoutIsTTY: boolean;
  readonly stdinIsTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly version: string;
  readonly nodeVersion: string;
  readonly bunVersion?: string;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly openCredentialStore: () => CredentialStore;
}

/** What a command's handler receives once global flags are resolved. */
export interface Context {
  readonly deps: Deps;
  readonly apiUrl: string;
  readonly outputMode: OutputMode;
  /** Calls that need no login. */
  readonly api: Api;
  /** The API with the user's token attached, or `auth_required` when there is no login. */
  readonly authed: () => ResultAsync<Api, DatinError>;
  /** The API with this exact token, whatever `--token` or `DATIN_TOKEN` say: for a token just issued or stored. */
  readonly withToken: (token: string) => Api;
  readonly token: () => Promise<ResolvedToken>;
  readonly credentials: CredentialStore;
  /** Record observed completed steps in the existing best-effort telemetry report. */
  readonly trackOnboarding: (...steps: OnboardingStep[]) => void;
  /** Progress for whoever is watching; goes to stderr and never into the result on stdout. */
  readonly notify: (event: string, fields: Record<string, unknown>, text: string) => void;
}
