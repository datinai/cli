import { resolve } from "node:path";
import { type Command, InvalidArgumentError } from "@commander-js/extra-typings";
import {
  type AccountExport,
  deleteAccount,
  exportAccount,
  getContacts,
  saveContacts,
  suggestLocation,
} from "@datin/api-client";
import { describe, type Finish } from "../define-command.ts";
import { loginAccount } from "../lib/credentials/store.ts";
import { authedErrors, type DatinError, localError } from "../lib/errors.ts";
import { updateState } from "../lib/home.ts";
import { fromLocal } from "../lib/local.ts";
import { clearLogoutData, logoutPaths } from "../lib/logout.ts";
import type { CommandOutput } from "../lib/output.ts";
import { writePrivateFile } from "../lib/private-file.ts";
import { errAsync, okAsync, type ResultAsync } from "../lib/result.ts";

export function registerAccount(program: Command, finish: Finish): void {
  registerAccountData(program, finish);

  const contacts = program
    .command("contacts")
    .description("How a match can reach you. Shown to someone only after you both liked each other");

  describe(
    contacts
      .command("set")
      .description("Set one or more contacts; pass an empty value to remove one")
      .option("--telegram <handle>")
      .option("--whatsapp <number>")
      .option("--email <address>")
      .option("--other <text>", "anything else, e.g. a Signal username")
      .action((options) =>
        finish((context) => {
          const body = Object.fromEntries(Object.entries(options).filter(([, value]) => typeof value === "string"));
          if (Object.keys(body).length === 0) {
            return errAsync(localError("usage_error", "Pass at least one of --telegram, --whatsapp, --email, --other"));
          }
          return context
            .authed()
            .andThen((api) => api.call((client) => saveContacts({ client, body })))
            .map((output) => {
              if (Object.values(output.data).some((value) => typeof value === "string" && value.length > 0))
                context.trackOnboarding("contacts");
              return output;
            });
        }),
      ),
    {
      examples: ['datin contacts set --telegram "@ada"', 'datin contacts set --email ""'],
      errors: [...authedErrors, "validation_failed"],
    },
  );

  describe(
    contacts
      .command("show")
      .description("Your contacts as datin has them")
      .action(() =>
        finish((context) => context.authed().andThen((api) => api.call((client) => getContacts({ client })))),
      ),
    { examples: ["datin contacts show --json"], errors: [...authedErrors] },
  );

  const location = program.command("location").description("Where the user is, for the `## location` section");
  describe(
    location
      .command("suggest")
      .description("Guess the user's city from this connection's IP address. Ask the user first, and say why")
      .option("--consented", "the user said yes to the lookup just now")
      .action((options) =>
        finish((context) =>
          context
            .authed()
            .andThen((api) =>
              api.call((client) =>
                suggestLocation({ client, query: { consented: options.consented ? "true" : "false" } }),
              ),
            ),
        ),
      ),
    {
      examples: ["datin location suggest --consented --json"],
      errors: [...authedErrors, "consent_required"],
    },
  );

  const schedule = program.command("schedule").description("The recurring check for new recommendations");
  describe(
    schedule
      .command("confirm")
      .description("Record that you set up a recurring pull with a scheduler that runs on this machine")
      .requiredOption("--every <interval>", "how often it runs, e.g. 3h")
      .requiredOption("--job <id-or-path>", "id or path of the active local scheduler task you verified", (value) => {
        if (!value.trim()) throw new InvalidArgumentError("Pass the scheduler task id or path");
        return value.trim();
      })
      .action((options) =>
        finish((context) =>
          fromLocal(
            updateState(context.deps.env, { schedule: options.every, scheduleJob: options.job }),
            "save the schedule on this machine",
          ).map(() => {
            context.trackOnboarding("schedule");
            return {
              data: { schedule: options.every, scheduleJob: options.job },
              summary: `Noted: recommendations are checked every ${options.every}`,
              next: [{ command: "datin onboarding status --json" }],
            };
          }),
        ),
      ),
    {
      examples: ['datin schedule confirm --every 3h --job "<scheduler job id or path>"'],
      errors: ["local_state_error"],
    },
  );
}

interface ExportWritten {
  readonly written_to: string;
  readonly exported_at: string;
}

/** `datin account`: the user's rights over their data, a copy of it and its deletion. */
function registerAccountData(program: Command, finish: Finish): void {
  const account = program.command("account").description("A copy of everything datin holds about you, or deleting it");

  describe(
    account
      .command("export")
      .description("Everything datin holds that you gave it or did; other people appear only by id")
      .option("--output <file>", "write the export to this file (owner-only) instead of printing it")
      .action((options) =>
        finish((context) =>
          context
            .authed()
            .andThen((api) => api.call((client) => exportAccount({ client })))
            .andThen((output): ResultAsync<CommandOutput<AccountExport | ExportWritten>, DatinError> => {
              if (!options.output) return okAsync(output);
              const path = resolve(options.output);
              return fromLocal(
                writePrivateFile(path, `${JSON.stringify(output.data, null, 2)}\n`).then(() => ({
                  data: { written_to: path, exported_at: output.data.exported_at },
                  summary: `Wrote the export to ${path}; only this user can read it`,
                })),
                "write the export",
              );
            }),
        ),
      ),
    {
      examples: ["datin account export --json", "datin account export --output ~/datin-export.json"],
      errors: [...authedErrors, "local_state_error"],
    },
  );

  describe(
    account
      .command("delete")
      .description("Delete the account and everything tied to it, on the server and on this machine. There is no undo")
      .option("--yes", "the user asked for their account to be deleted")
      .action((options) =>
        finish((context) => {
          if (!options.yes) {
            return errAsync(
              localError("confirmation_required", "Deleting the account removes everything and cannot be undone", {
                hint: "Say what goes: the profile, contacts, matches and every login. Offer `datin account export` first. Only on the user's explicit yes, run the command below",
                next: [
                  { command: "datin account delete --yes", when: "only after the user explicitly asked to delete" },
                ],
              }),
            );
          }
          return context
            .authed()
            .andThen((api) => api.call((client) => deleteAccount({ client, body: { confirm: true } })))
            .andThen(() =>
              // The server session is gone with the account, so what is left here is only a stale copy.
              fromLocal(
                (async () => {
                  await context.credentials.delete(loginAccount(context.apiUrl));
                  await clearLogoutData(logoutPaths(context.deps.env));
                  return {
                    data: { deleted: true as const, local_data_cleared: true as const },
                    summary: "The account is deleted, and so is datin's data on this machine. Nothing can be restored",
                  };
                })(),
                "clear the login and local datin data",
              ),
            );
        }),
      ),
    {
      examples: ["datin account delete", "datin account delete --yes"],
      errors: [...authedErrors, "confirmation_required", "local_state_error"],
      destructive: true,
    },
  );
}
