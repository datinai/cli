import { platform } from "node:os";
import { type Command, Option } from "@commander-js/extra-typings";
import { createFeedback, type NewFeedback } from "@datin/api-client";
import { describe, type Finish } from "../define-command.ts";
import { authedErrors } from "../lib/errors.ts";

const KINDS = ["bug", "idea", "other"] as const satisfies readonly NewFeedback["kind"][];

export function registerFeedback(program: Command, finish: Finish): void {
  const feedback = program
    .command("feedback")
    .description("Tell the datin team something. A person reads every message; the user gets an email that it arrived");

  describe(
    feedback
      .command("create")
      .description("Send a bug report, an idea, or anything else the user wants us to hear")
      .requiredOption(
        "--message <text>",
        "what the user said, or your account of a bug: command, error, what was expected",
      )
      .addOption(new Option("--kind <kind>", "type of feedback").choices(KINDS).default("other"))
      .option("--agent <name>", "which harness you are, e.g. claude or codex")
      .option("--agent-model <id>", "the model you are running")
      .action((flags) =>
        finish((context) =>
          context.authed().andThen((api) =>
            api.call((client) =>
              createFeedback({
                client,
                body: {
                  kind: flags.kind,
                  message: flags.message,
                  cli_version: context.deps.version,
                  os: platform(),
                  ...(flags.agent && { agent: flags.agent }),
                  ...(flags.agentModel && { agent_model: flags.agentModel }),
                },
              }),
            ),
          ),
        ),
      ),
    {
      examples: [
        'datin feedback create --kind idea --message "Let me say why I passed on someone" --agent claude',
        'datin feedback create --kind bug --message "profile push answered profile_conflict right after a pull" --agent codex --agent-model gpt-5.5',
      ],
      errors: [...authedErrors, "validation_failed"],
    },
  );
}
