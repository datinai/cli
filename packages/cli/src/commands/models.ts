import { type Command, Option } from "@commander-js/extra-typings";
import { checkModel, type Effort, getModels, type ModelCheck, type ModelsResponse } from "@datin/api-client";
import { describe, type Finish } from "../define-command.ts";
import { apiErrors, localError } from "../lib/errors.ts";
import { updateState } from "../lib/home.ts";
import { fromLocal } from "../lib/local.ts";
import type { CommandOutput } from "../lib/output.ts";
import { errAsync } from "../lib/result.ts";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly Effort[];

function renderList({ data, summary }: CommandOutput<ModelsResponse["data"]>): string {
  const rows = data.providers.map(
    (p) =>
      `${p.provider}: recommended ${p.recommended.name} (${p.recommended.id})${
        p.accepted.length ? `, also ${p.accepted.map((m) => m.name).join(", ")}` : ""
      }${p.minimum_effort ? `, at ${p.minimum_effort} effort or higher` : ""}\n  ${p.how_to_switch}`,
  );
  return [summary, ...rows, `other providers: ${data.unknown_provider}`, `applies to: ${data.applies_to}`]
    .filter(Boolean)
    .join("\n");
}

function renderCheck({ data }: CommandOutput<ModelCheck>): string {
  const subject = data.normalized || data.provider || "your model";
  return [`${subject}: ${data.verdict}`, data.advice, data.how_to_switch].filter(Boolean).join("\n");
}

export function registerModels(program: Command, finish: Finish): void {
  const models = describe(
    program
      .command("models")
      .description("Which model your agent should run for onboarding, per provider")
      .action(() => finish((context) => context.api.call((client) => getModels({ client })), renderList)),
    { examples: ["datin models --json", "datin models check --model claude-fable-5-1"], errors: [...apiErrors] },
  );

  describe(
    models
      .command("check")
      .description(
        "Check the model you, the agent, run on. Pass the exact id your context states; if your harness does not show it, pass your provider and tell the user what `advice` says",
      )
      .option("--model <id>", "your exact model id, e.g. claude-opus-5-5[1m] or zai/glm-5.3")
      .addOption(new Option("--effort <level>", "your reasoning effort, if your context states it").choices(EFFORTS))
      .option(
        "--provider <name>",
        "when you cannot see your model: anthropic, openai, xai, meta, moonshot, zhipu, alibaba, deepseek or any",
      )
      .action(({ model, effort, provider }) =>
        finish((context) => {
          const query =
            model !== undefined && provider === undefined
              ? { model, ...(effort && { effort }) }
              : provider !== undefined && model === undefined
                ? { provider }
                : undefined;
          if (!query) {
            return errAsync(
              localError("usage_error", "Pass either --model or --provider", {
                hint: "--model when your context states your exact model id; otherwise --provider, and tell the user the recommendation",
              }),
            );
          }
          return (
            context.api
              .call((client) => checkModel({ client, query }))
              // The verdict is what onboarding needs; which way the user went after it is theirs to decide.
              .andThen((output) =>
                fromLocal(
                  updateState(context.deps.env, {
                    modelChecked: true,
                    ...(output.data.normalized && { agentModel: output.data.normalized }),
                  }),
                  "remember the model check on this machine",
                ).map(() => {
                  context.trackOnboarding("model_check");
                  return output;
                }),
              )
          );
        }, renderCheck),
      ),
    {
      examples: [
        "datin models check --model claude-fable-5-1 --json",
        "datin models check --model gpt-6-astra --effort high --json",
        "datin models check --provider openai --json",
      ],
      errors: [...apiErrors, "validation_failed", "local_state_error"],
    },
  );
}
