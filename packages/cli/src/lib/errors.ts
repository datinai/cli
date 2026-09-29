import type { ErrorEnvelope, NextCommand, ErrorCode as ServerErrorCode } from "@datin/api-client";

/** Failures only the CLI itself can raise; the server never sends these. */
export type LocalErrorCode = "usage_error" | "network_error" | "confirmation_required" | "local_state_error";

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
} as const satisfies Record<ErrorCode, number>;

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
} as const satisfies Record<LocalErrorCode, boolean>;

export function localError(
  code: LocalErrorCode,
  message: string,
  extra: Pick<DatinError, "hint" | "details" | "next"> = {},
): DatinError {
  return { code, message, retryable: localRetryable[code], ...extra };
}

export function fromEnvelope(envelope: ErrorEnvelope): DatinError {
  const { code, message, retryable, hint, details } = envelope.error;
  return {
    code,
    message,
    retryable,
    ...(hint !== undefined && { hint }),
    ...(details !== undefined && { details }),
    ...(envelope.next !== undefined && { next: envelope.next }),
  };
}

/** Boundary check for bodies that claim to be an error envelope; anything else is treated as a server fault. */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { ok?: unknown; error?: { code?: unknown; message?: unknown; retryable?: unknown } };
  return (
    candidate.ok === false &&
    typeof candidate.error === "object" &&
    candidate.error !== null &&
    typeof candidate.error.code === "string" &&
    Object.hasOwn(exitCodes, candidate.error.code) &&
    typeof candidate.error.message === "string" &&
    typeof candidate.error.retryable === "boolean"
  );
}
