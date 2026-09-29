import type { Command } from "@commander-js/extra-typings";
import { AGENT_IDS, AGENT_INSTRUCTIONS, type AgentId } from "../agents/instructions.gen.ts";
import { describe, type Finish } from "../define-command.ts";
import { localError } from "../lib/errors.ts";
import { errAsync, okAsync } from "../lib/result.ts";

const isAgentId = (name: string): name is AgentId => (AGENT_IDS as readonly string[]).includes(name);

export function registerAgent(program: Command, finish: Finish): void {
  const agent = program
    .command("agent")
    .description("How datin works from inside a particular agent harness: its tools, scheduler, history and limits");

  describe(
    agent
      .command("list")
      .description("Every harness datin has instructions for")
      .action(() =>
        finish(() =>
          okAsync({
            data: { agents: AGENT_IDS.map((id) => ({ id, title: AGENT_INSTRUCTIONS[id].title })) },
            next: [{ command: "datin agent instructions <id> --json", when: "with the id that is you" }],
          }),
        ),
      ),
    { examples: ["datin agent list --json"], errors: [] },
  );

  describe(
    agent
      .command("instructions")
      .description("Harness-specific notes to read once at the start: which of your tools to use for what")
      .argument("<agent>", `one of ${AGENT_IDS.join(", ")}`)
      .action((name) =>
        finish(
          () => {
            if (!isAgentId(name)) {
              return errAsync(
                localError("usage_error", `\`${name}\` is not a harness datin knows`, {
                  hint: `Pick the one that is you: ${AGENT_IDS.join(", ")}. If none is, follow the skill as written`,
                  next: [{ command: "datin agent list --json" }],
                }),
              );
            }
            const { title, markdown } = AGENT_INSTRUCTIONS[name];
            return okAsync({
              data: { agent: name, title, markdown },
              summary: `Read these once, then follow the skill; run \`datin onboarding status --json\` to see where the user is`,
            });
          },
          ({ data, summary }) => [summary, data.markdown].filter(Boolean).join("\n\n"),
        ),
      ),
    { examples: ["datin agent instructions claude --json", "datin agent instructions codex"], errors: [] },
  );
}
