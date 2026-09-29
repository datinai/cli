import { type DatinError, localError } from "./errors.ts";
import { ResultAsync } from "./result.ts";

/**
 * For work on this machine that can really fail: files under ~/.datin and ~/.config/datin. A full disk, a permission problem or a corrupted file becomes a typed error that says where
 * to look, instead of an unexplained crash.
 */
export function fromLocal<T>(work: Promise<T>, doing: string): ResultAsync<T, DatinError> {
  return ResultAsync.fromPromise(work, (cause) => {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const path =
      typeof (cause as NodeJS.ErrnoException)?.path === "string" ? (cause as NodeJS.ErrnoException).path : undefined;
    return localError("local_state_error", `Could not ${doing}: ${reason}`, {
      hint: "Check that ~/.datin and ~/.config/datin are readable and writable by you. A corrupted file there can be deleted; datin recreates it",
      details: { ...(path && { path }) },
    });
  });
}
