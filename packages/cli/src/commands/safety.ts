import type { Command } from "@commander-js/extra-typings";
import { blockPerson, reportPerson } from "@datin/api-client";
import { describe, type Finish } from "../define-command.ts";
import { authedErrors, localError } from "../lib/errors.ts";
import { errAsync } from "../lib/result.ts";

/** Both are final: nobody is unblocked, so both ask for the user's explicit yes like any destructive command. */
export function registerSafety(program: Command, finish: Finish): void {
  describe(
    program
      .command("block")
      .description("Stop seeing someone, and stop them seeing you. Ends a match between you. Final")
      .argument("<id>", "candidate_id from recs, check or matches")
      .option("--yes", "the user asked to block this person")
      .action((id, options) =>
        finish((context) =>
          options.yes
            ? context.authed().andThen((api) => api.call((client) => blockPerson({ client, path: { id } })))
            : errAsync(
                localError("confirmation_required", "Blocking is final and ends any match with this person", {
                  next: [{ command: `datin block ${id} --yes`, when: "only after the user said to block them" }],
                }),
              ),
        ),
      ),
    {
      examples: ["datin block 4f0e8f0a-5a57-4f0e-9d53-0d8d3c1f7a11 --yes"],
      errors: [...authedErrors, "not_found", "confirmation_required"],
      destructive: true,
    },
  );

  describe(
    program
      .command("report")
      .description(
        "Tell the datin team about someone, in the user's words. Also blocks them. A person reads every report",
      )
      .argument("<id>", "candidate_id from recs, check or matches")
      .requiredOption("--description <text>", "what happened, as the user told it")
      .option("--yes", "the user asked to report this person")
      .action((id, options) =>
        finish((context) =>
          options.yes
            ? context
                .authed()
                .andThen((api) =>
                  api.call((client) =>
                    reportPerson({ client, path: { id }, body: { description: options.description } }),
                  ),
                )
            : errAsync(
                localError("confirmation_required", "Reporting sends this to the datin team and blocks the person", {
                  next: [
                    {
                      command: `datin report ${id} --description "…" --yes`,
                      when: "only after the user said to report them",
                    },
                  ],
                }),
              ),
        ),
      ),
    {
      examples: ['datin report 4f0e8f0a-5a57-4f0e-9d53-0d8d3c1f7a11 --description "Asked for money" --yes'],
      errors: [...authedErrors, "not_found", "validation_failed", "rate_limited", "confirmation_required"],
      destructive: true,
    },
  );
}
