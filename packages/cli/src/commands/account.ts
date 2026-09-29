import { type Command, InvalidArgumentError } from "@commander-js/extra-typings";
import { getContacts, saveContacts, suggestLocation } from "@datin/api-client";
import { describe, type Finish } from "../define-command.ts";
import { authedErrors, localError } from "../lib/errors.ts";
import { updateState } from "../lib/home.ts";
import { fromLocal } from "../lib/local.ts";
import { errAsync } from "../lib/result.ts";

export function registerAccount(program: Command, finish: Finish): void {
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
