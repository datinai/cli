import { type Client, createClient, createConfig } from "@datin/api-client";
import { type DatinError, fromEnvelope, isErrorEnvelope, localError } from "./errors.ts";
import type { CommandOutput } from "./output.ts";
import { err, ok, ResultAsync } from "./result.ts";

export const DEFAULT_API_URL = "https://api.datinapp.com";

/** Shape every generated SDK call resolves to when it does not throw. */
interface SdkResult<Body> {
  data?: Body | undefined;
  error?: unknown;
  response?: Response | undefined;
}

interface SuccessBody<Data> {
  ok: true;
  data: Data;
  summary?: string | undefined;
  next?: CommandOutput<Data>["next"] | undefined;
}

export interface Api {
  /** Runs one generated SDK call and folds every way it can fail into a typed error. */
  call<Data>(
    request: (client: Client) => Promise<SdkResult<SuccessBody<Data>>>,
  ): ResultAsync<CommandOutput<Data>, DatinError>;
}

export interface ApiOptions {
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
  readonly userAgent: string;
  readonly token?: string;
  /** Sits out a pause the API asked for; the caller decides how to tell whoever is watching. */
  readonly pause: (seconds: number) => Promise<void>;
}

/**
 * The API's burst limits reset within ten seconds. Waiting that out here means an agent never has to
 * notice; anything longer (a daily quota, a cooldown) is the caller's decision, so it is reported.
 */
const LONGEST_AUTOMATIC_WAIT_SECONDS = 15;

function shortWait(error: DatinError): number | undefined {
  const seconds = error.code === "rate_limited" ? error.details?.retry_after_seconds : undefined;
  return typeof seconds === "number" && seconds <= LONGEST_AUTOMATIC_WAIT_SECONDS ? seconds : undefined;
}

export function createRawClient(options: Omit<ApiOptions, "pause">): Client {
  return createClient(
    createConfig({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      headers: { "user-agent": options.userAgent, ...(options.token && { authorization: `Bearer ${options.token}` }) },
    }),
  );
}

export function createApi(options: ApiOptions): Api {
  const client = createRawClient(options);

  const attempt: Api["call"] = (request) =>
    ResultAsync.fromPromise(request(client), (cause) =>
      localError("network_error", `Could not reach ${options.baseUrl}`, {
        hint: "Check the connection and try again",
        details: { cause: cause instanceof Error ? cause.message : String(cause) },
      }),
    ).andThen(({ data, error, response }) => {
      if (data?.ok) {
        const { data: payload, summary, next } = data;
        return ok({ data: payload, ...(summary !== undefined && { summary }), ...(next !== undefined && { next }) });
      }
      if (isErrorEnvelope(error)) return err(fromEnvelope(error));
      if (response === undefined) {
        return err(
          localError("network_error", `Could not reach ${options.baseUrl}`, {
            hint: "Check the connection and try again",
          }),
        );
      }
      return err<never, DatinError>({
        code: "internal_error",
        message: `The API answered ${response.status} without a readable error`,
        retryable: true,
      });
    });

  return {
    // One more try after a short pause, never a loop: a second refusal is reported as it is.
    call: (request) =>
      attempt(request).orElse((error) => {
        const seconds = shortWait(error);
        return seconds === undefined
          ? err(error)
          : ResultAsync.fromSafePromise(options.pause(seconds)).andThen(() => attempt(request));
      }),
  };
}
