import type { ErrorEnvelope, NextCommand, ErrorCode as ServerErrorCode } from "@datin/api-client";

/** Failures only the CLI itself can raise; the server never sends these. */
export type LocalErrorCode =
  | "usage_error"
  | "network_error"
  | "confirmation_required"
  | "local_state_error"
  | "unattended_refused";

export type ErrorCode = ServerErrorCode | LocalErrorCode;

/** Shared failures for command help and discovery; add each endpoint's specific errors at its command. */
export const apiErrors = ["network_error", "rate_limited"] as const satisfies readonly ErrorCode[];
export const authedErrors = [
  ...apiErrors,
  "auth_required",
  "account_disabled",
  "local_state_error",
] as const satisfies readonly ErrorCode[];

/**
 * Exit code per failure class, so an agent can branch without parsing text.
 * `satisfies` makes this exhaustive: a new server error code fails the build until it is mapped here.
 */
export const exitCodes = {
  internal_error: 1,
  usage_error: 2,
  auth_required: 3,
  login_pending: 3,
  login_expired: 3,
  account_disabled: 3,
  not_found: 4,
  profile_conflict: 5,
  validation_failed: 6,
  network_error: 7,
  rate_limited: 8,
  confirmation_required: 9,
  consent_required: 10,
  source_disabled: 11,
  reconnect_required: 12,
  local_state_error: 13,
  update_required: 14,
  unattended_refused: 15,
} as const satisfies Record<ErrorCode, number>;

/**
 * The per-account daily quotas a `rate_limited` refusal can name in `details.limited_by`. Unlike a burst limit,
 * even a short remaining wait is never retried by the CLI: the user decides what happens next.
 */
const DAILY_LIMITS = new Set(["likes", "passes", "pushes", "identity_edits"]);

export function dailyLimitOf(error: DatinError): string | undefined {
  const limit = error.details?.limited_by;
  return error.code === "rate_limited" && typeof limit === "string" && DAILY_LIMITS.has(limit) ? limit : undefined;
}

/** How to get a current CLI; the server's `update_required` refusal always ends with it. */
export const UPDATE_COMMAND = "bunx datin@latest";

export interface DatinError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly next?: NextCommand[];
}

const localRetryable = {
  usage_error: false,
  network_error: true,
  confirmation_required: false,
  local_state_error: false,
  unattended_refused: false,
} as const satisfies Record<LocalErrorCode, boolean>;

export function localError(
  code: LocalErrorCode,
  message: string,
  extra: Pick<DatinError, "hint" | "details" | "next"> = {},
): DatinError {
  return { code, message, retryable: localRetryable[code], ...extra };
}

/** An error envelope as it arrives: a newer API may send a code this CLI has never heard of. */
export type ReceivedErrorEnvelope = Omit<ErrorEnvelope, "error"> & {
  readonly error: Omit<ErrorEnvelope["error"], "code"> & { readonly code: string };
};

const isServerCode = (code: string): code is ServerErrorCode =>
  Object.hasOwn(exitCodes, code) && !Object.hasOwn(localRetryable, code);

/**
 * A code this CLI doesn't know is reported as `internal_error`, but with the server's own message and hint: an
 * older CLI then still tells the user what the API said, instead of "answered without a readable error".
 */
export function fromEnvelope(envelope: ReceivedErrorEnvelope): DatinError {
  const { code, message, retryable, hint, details } = envelope.error;
  const known = isServerCode(code);
  const mergedHint =
    code === "update_required" && !hint?.includes(UPDATE_COMMAND)
      ? [hint, `Update datin: run \`${UPDATE_COMMAND}\``].filter(Boolean).join(". ")
      : hint;
  const mergedDetails = known ? details : { ...details, server_code: code };
  return {
    code: known ? code : "internal_error",
    message,
    retryable,
    ...(mergedHint !== undefined && { hint: mergedHint }),
    ...(mergedDetails !== undefined && { details: mergedDetails }),
    ...(envelope.next !== undefined && { next: envelope.next }),
  };
}

/** Boundary check for bodies that claim to be an error envelope; anything else is treated as a server fault. */
export function isErrorEnvelope(value: unknown): value is ReceivedErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { ok?: unknown; error?: { code?: unknown; message?: unknown; retryable?: unknown } };
  return (
    candidate.ok === false &&
    typeof candidate.error === "object" &&
    candidate.error !== null &&
    typeof candidate.error.code === "string" &&
    typeof candidate.error.message === "string" &&
    typeof candidate.error.retryable === "boolean"
  );
}
