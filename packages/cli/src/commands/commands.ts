import type { Command } from "@commander-js/extra-typings";
import { describe, type Finish, metaOf } from "../define-command.ts";
import { okAsync } from "../lib/result.ts";

interface CommandEntry {
  readonly command: string;
  readonly description: string;
  readonly arguments: { name: string; required: boolean; description: string }[];
  readonly options: CommandOption[];
  readonly examples: readonly string[];
  readonly errors: readonly string[];
  readonly destructive: boolean;
}

interface CommandOption {
  readonly flags: string;
  readonly description: string;
  /** The option itself must be present, independently of whether it takes a value. */
  readonly required: boolean;
  readonly value_required: boolean;
  readonly value_optional: boolean;
  readonly default?: unknown;
  readonly choices?: readonly string[];
}

function optionsOf(command: Pick<Command, "options">): CommandOption[] {
  return command.options.map((option) => ({
    flags: option.flags,
    description: option.description,
    required: option.mandatory,
    value_required: option.required,
    value_optional: option.optional,
    ...(option.defaultValue !== undefined && { default: option.defaultValue }),
    ...(option.argChoices && { choices: option.argChoices }),
  }));
}

function catalog(root: Command): CommandEntry[] {
  const entries: CommandEntry[] = [];
  const visit = (command: Command, path: string[]) => {
    for (const child of command.commands) {
      const childPath = [...path, child.name()];
      if (child.commands.length > 0) visit(child as Command, childPath);
      const meta = metaOf(child);
      // A group like `profile` is only a heading; a command with subcommands of its own (`models`) is listed too.
      if (child.commands.length > 0 && !meta) continue;
      entries.push({
        command: childPath.join(" "),
        description: child.description(),
        arguments: child.registeredArguments.map((a) => ({
          name: a.name(),
          required: a.required,
          description: a.description,
        })),
        options: optionsOf(child),
        examples: meta?.examples ?? [],
        errors: meta?.errors ?? [],
        destructive: meta?.destructive ?? false,
      });
    }
  };
  visit(root, [root.name()]);
  return entries;
}

export function registerCommands(program: Command, finish: Finish): void {
  describe(
    program
      .command("commands")
      .description("List every command with its options, examples and possible errors")
      .action(() =>
        finish(
          () => okAsync({ data: { commands: catalog(program), global_options: optionsOf(program) } }),
          ({ data }) => data.commands.map((entry) => `${entry.command}\n  ${entry.description}`).join("\n"),
        ),
      ),
    { examples: ["datin commands --json"], errors: [] },
  );
}
