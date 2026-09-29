import { type Command, InvalidArgumentError } from "@commander-js/extra-typings";
import { finishDeviceLogin, getMe, logout, type Me, startDeviceLogin } from "@datin/api-client";
import type { Context } from "../context.ts";
import { describe, type Finish } from "../define-command.ts";
import { loginAccount } from "../lib/credentials/store.ts";
import { apiErrors, authedErrors, type DatinError, localError } from "../lib/errors.ts";
import { fromLocal } from "../lib/local.ts";
import { clearLogoutData, logoutPaths, unfinishedLogoutWork } from "../lib/logout.ts";
import type { CommandOutput } from "../lib/output.ts";
import { type PendingLogin, pendingLogin } from "../lib/pending-login.ts";
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "../lib/result.ts";

interface LoginStarted {
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_at: string;
}

interface LoggedIn {
  readonly logged_in: true;
  readonly user: Me;
  /** The owner-only file holding the token. */
  readonly stored_in: string;
}

const accountOf = (context: Context) => loginAccount(context.apiUrl);

interface AlreadyLoggedIn {
  readonly logged_in: true;
  readonly already: true;
  readonly user: Me;
}

/**
 * A working login makes `datin login` a no-op, so an agent that runs it out of habit never shows the user a
 * code they don't need. A dead or missing token falls through to a fresh device login.
 */
function existingLogin(context: Context): ResultAsync<CommandOutput<AlreadyLoggedIn> | undefined, DatinError> {
  return fromLocal(context.token(), "read the login on this machine").andThen((resolved) =>
    resolved.token
      ? context
          .authed()
          .andThen((api) => api.call((client) => getMe({ client })))
          .map(({ data }): CommandOutput<AlreadyLoggedIn> | undefined => ({
            data: { logged_in: true, already: true, user: data },
            summary: `Already logged in as ${data.name}; nothing to do. To switch accounts, run \`datin logout\` first`,
            next: [{ command: "datin onboarding status --json" }],
          }))
          .orElse((error) => (error.code === "auth_required" ? okAsync(undefined) : errAsync(error)))
      : okAsync(undefined),
  );
}

function start(context: Context): ResultAsync<PendingLogin, DatinError> {
  return context.api
    .call((client) => startDeviceLogin({ client }))
    .map(({ data }) => ({
      apiUrl: context.apiUrl,
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      intervalSeconds: data.interval,
      expiresAt: new Date(context.deps.now().getTime() + data.expires_in * 1000).toISOString(),
    }))
    .andThen((pending) =>
      fromLocal(
        pendingLogin.save(context.deps.env, pending).then(() => {
          context.trackOnboarding(); // Start the attempt even if the user never approves the login.
          return pending;
        }),
        "read or write the login on this machine",
      ),
    );
}

const started = (pending: PendingLogin): CommandOutput<LoginStarted> => ({
  data: {
    user_code: pending.userCode,
    verification_uri: pending.verificationUri,
    verification_uri_complete: pending.verificationUriComplete,
    expires_at: pending.expiresAt,
  },
  summary: `Ask the user to open ${pending.verificationUriComplete} and confirm the code ${pending.userCode}`,
  next: [{ command: "datin login --wait", when: "right after showing the user the link and the code" }],
});

/** Polls until the user confirms, the code expires, or `timeoutSeconds` runs out (the login stays resumable). */
async function poll(
  context: Context,
  pending: PendingLogin,
  timeoutSeconds: number | undefined,
): Promise<Result<CommandOutput<LoggedIn>, DatinError>> {
  const { now, sleep, env } = context.deps;
  const expiry = new Date(pending.expiresAt).getTime();
  const deadline = timeoutSeconds === undefined ? expiry : Math.min(expiry, now().getTime() + timeoutSeconds * 1000);
  let interval = pending.intervalSeconds;

  for (;;) {
    const polled = await context.api.call((client) =>
      finishDeviceLogin({ client, body: { device_code: pending.deviceCode } }),
    );
    if (polled.isOk()) {
      const { token } = polled.value.data;
      await context.credentials.set(accountOf(context), token);
      await pendingLogin.clear(env);
      // The new login, even when `DATIN_TOKEN` or `--token` name someone else for other commands.
      const me = await context.withToken(token).call((client) => getMe({ client }));
      if (me.isErr()) return err(me.error);
      context.trackOnboarding("login");
      return ok({
        data: { logged_in: true, user: me.value.data, stored_in: context.credentials.path },
        summary: `Logged in as ${me.value.data.name} (${me.value.data.email})`,
        next: [{ command: "datin onboarding status" }],
      });
    }

    if (polled.error.code !== "login_pending") {
      if (polled.error.code === "login_expired") await pendingLogin.clear(env);
      return err(polled.error);
    }
    const suggested = polled.error.details?.interval;
    if (typeof suggested === "number") interval = suggested;
    if (now().getTime() + interval * 1000 > deadline) {
      const expired = now().getTime() + interval * 1000 > expiry;
      if (expired) await pendingLogin.clear(env);
      return err(
        expired
          ? {
              code: "login_expired",
              message: "The code expired before it was confirmed",
              hint: "Start again with `datin login`",
              retryable: false,
              next: [{ command: "datin login --no-wait --json" }],
            }
          : {
              ...polled.error,
              hint: "Still waiting for the user; run `datin login --wait` again",
              next: [{ command: "datin login --wait" }],
            },
      );
    }
    await sleep(interval * 1000);
  }
}

function wait(context: Context, timeoutSeconds: number | undefined): ResultAsync<CommandOutput<LoggedIn>, DatinError> {
  return fromLocal(pendingLogin.load(context.deps.env), "read or write the login on this machine").andThen(
    (pending) => {
      if (!pending || pending.apiUrl !== context.apiUrl) {
        return err(
          localError("usage_error", "There is no login in progress to wait for", {
            hint: "Start one with `datin login --no-wait`",
            next: [{ command: "datin login --no-wait --json" }],
          }),
        );
      }
      return fromLocal(poll(context, pending, timeoutSeconds), "store the login on this machine").andThen(
        (result) => result,
      );
    },
  );
}

const renderLoggedIn = ({ data, summary }: CommandOutput<LoggedIn>) =>
  `${summary ?? `Logged in as ${data.user.name} (${data.user.email})`}\ntoken stored in: ${data.stored_in}`;

export function registerAuth(program: Command, finish: Finish): void {
  describe(
    program
      .command("login")
      .description("Log in by confirming a short code; opens the browser for plain interactive login")
      .option("--no-browser", "print the approval link without opening a browser")
      // Declared as a pair, so `wait` is true, false, or undefined for a plain `datin login`.
      .option("--wait", "finish a login started with --no-wait")
      .option("--no-wait", "print the code and link, then exit; finish later with --wait (best for agents)")
      .option(
        "--timeout <seconds>",
        "plain login or --wait: stop after this long; 0 polls once; login stays resumable",
        (value) => {
          const seconds = Number(value);
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(seconds))
            throw new InvalidArgumentError("Timeout must be a whole number of seconds, 0 or greater");
          return seconds;
        },
      )
      .action((options) => {
        if (options.wait === false)
          return finish(
            (context) =>
              existingLogin(context).andThen(
                (existing): ResultAsync<CommandOutput<LoginStarted | AlreadyLoggedIn>, DatinError> =>
                  existing ? okAsync(existing) : start(context).map(started),
              ),
            ({ data, summary }) =>
              "already" in data ? (summary ?? "") : `Open ${data.verification_uri_complete}\nCode: ${data.user_code}`,
          );
        if (options.wait === true) return finish((context) => wait(context, options.timeout), renderLoggedIn);
        return finish(
          (context) =>
            start(context).andThen((pending) => {
              context.notify(
                "login_started",
                {
                  user_code: pending.userCode,
                  verification_uri_complete: pending.verificationUriComplete,
                  expires_at: pending.expiresAt,
                },
                `Open ${pending.verificationUriComplete} and confirm the code ${pending.userCode}\nWaiting…`,
              );
              return fromLocal(
                (async () => {
                  if (options.browser && context.outputMode === "human" && context.deps.stdinIsTTY) {
                    try {
                      await context.deps.openBrowser(pending.verificationUriComplete);
                    } catch {
                      context.notify(
                        "browser_unavailable",
                        {},
                        "Could not open your browser. Open the link above to continue.",
                      );
                    }
                  }
                  return poll(context, pending, options.timeout);
                })(),
                "store the login on this machine",
              ).andThen((result) => result);
            }),
          renderLoggedIn,
        );
      }),
    {
      examples: [
        "datin login",
        "datin login --no-browser",
        "datin login --no-wait --json",
        "datin login --wait --timeout 90",
      ],
      errors: [...authedErrors, "login_pending", "login_expired"],
    },
  );

  describe(
    program
      .command("logout")
      .description("End this login and clear local Datin data; the saved server profile and account remain")
      .option("--yes", "discard unfinished local work: evidence and unpushed drafts cannot be restored by login")
      .action((options) =>
        finish((context) => {
          const paths = logoutPaths(context.deps.env);
          const inspect = options.yes
            ? okAsync<string[], DatinError>([])
            : fromLocal(unfinishedLogoutWork(context.deps.env, context.deps.now()), "check for unfinished local work");
          return inspect.andThen((unfinished) => {
            if (unfinished.length > 0)
              return errAsync(
                localError(
                  "confirmation_required",
                  "Logout would discard: " +
                    unfinished.join(", ") +
                    ". Local evidence and unpushed drafts cannot be restored by logging in again",
                  {
                    hint: "Finish or save a copy of this work first, or pass --yes to discard it. Your saved server profile and account remain intact",
                    details: { unfinished, paths },
                    next: [
                      {
                        command: "datin logout --yes",
                        when: "only after the user agrees to discard unfinished local work",
                      },
                    ],
                  },
                ),
              );
            // The token in use (`--token`, `DATIN_TOKEN` or the stored one) and the stored one, if different:
            // logging out must not leave a working login behind on disk.
            return fromLocal(
              Promise.all([context.token(), context.credentials.get(accountOf(context))]),
              "read the login on this machine",
            ).andThen(([resolved, stored]) => {
              const tokens = [...new Set([resolved.token, stored].filter((token) => token !== undefined))];
              const revoke = ResultAsync.combine(
                tokens.map((token) =>
                  context
                    .withToken(token)
                    .call((client) => logout({ client }))
                    .map(() => true)
                    // Clear locally even offline, but report that server revocation was not confirmed.
                    .orElse(() => okAsync<boolean, DatinError>(false)),
                ),
              ).map((results) => tokens.length > 0 && results.every(Boolean));
              return revoke.andThen((revoked) =>
                fromLocal(
                  (async () => {
                    await context.credentials.delete(accountOf(context));
                    await clearLogoutData(paths);
                    return {
                      data: {
                        logged_out: true as const,
                        was_logged_in: tokens.length > 0,
                        revoked,
                        local_data_cleared: true as const,
                      },
                      summary:
                        tokens.length > 0 && !revoked
                          ? "Cleared local Datin data, but could not confirm server token revocation"
                          : "Logged out and cleared local Datin data. Your saved server profile and account remain intact",
                      next: [{ command: "datin login --no-wait --json" }],
                    };
                  })(),
                  "clear the login and local Datin data",
                ),
              );
            });
          });
        }),
      ),
    {
      examples: ["datin logout", "datin logout --yes"],
      errors: ["confirmation_required", "local_state_error"],
      destructive: true,
    },
  );

  describe(
    program
      .command("whoami")
      .description("Show who is logged in; fails with auth_required when nobody is")
      .action(() =>
        finish(
          (context) => context.authed().andThen((api) => api.call((client) => getMe({ client }))),
          ({ data }) => `${data.name} <${data.email}>`,
        ),
      ),
    { examples: ["datin whoami --json"], errors: [...authedErrors] },
  );

  const auth = program.command("auth").description("Inspect the login on this machine");
  describe(
    auth
      .command("status")
      .description(
        "Whether this machine is logged in, and where the token comes from. Never fails just because you are logged out",
      )
      .action(() =>
        finish(
          (context) =>
            fromLocal(
              Promise.all([context.token(), pendingLogin.load(context.deps.env)]),
              "read or write the login on this machine",
            ).andThen(([resolved, pending]) => {
              const base = {
                api_url: context.apiUrl,
                token_source: resolved.source,
                login_in_progress: pending?.apiUrl === context.apiUrl,
              };
              if (!resolved.token) {
                return okAsync({
                  data: { logged_in: false, ...base },
                  next: [{ command: "datin login --no-wait --json" }],
                });
              }
              return context
                .authed()
                .andThen((api) => api.call((client) => getMe({ client })))
                .map(({ data }) => ({ data: { logged_in: true, ...base, user: data } }))
                .orElse((error) =>
                  error.code === "auth_required"
                    ? okAsync({
                        data: { logged_in: false, ...base, problem: "The stored token is no longer valid" },
                        next: [{ command: "datin login --no-wait --json" }],
                      })
                    : errAsync(error),
                );
            }),
          ({ data }) => (data.logged_in ? `logged in (token from ${data.token_source})` : "not logged in"),
        ),
      ),
    { examples: ["datin auth status --json"], errors: [...apiErrors, "account_disabled", "local_state_error"] },
  );
}
