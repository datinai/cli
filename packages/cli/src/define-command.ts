import type { CommandUnknownOpts } from "@commander-js/extra-typings";
import type { Context } from "./context.ts";
import type { DatinError, ErrorCode } from "./lib/errors.ts";
import type { CommandOutput } from "./lib/output.ts";
import type { ResultAsync } from "./lib/result.ts";

/** Facts about a command that help text and `datin commands` are both built from. */
export interface CommandMeta {
  readonly examples: readonly string[];
  /** Expected handler failures. Parsing and unexpected failures are added for every command. */
  readonly errors: readonly ErrorCode[];
  /** May discard local work; commands enforce their own `--yes` conditions. */
  readonly destructive?: boolean;
}

export type Handler<Data> = (context: Context) => ResultAsync<CommandOutput<Data>, DatinError>;

export type Finish = <Data>(handler: Handler<Data>, render?: (output: CommandOutput<Data>) => string) => Promise<void>;

const registry = new WeakMap<object, CommandMeta>();

export function describe<C extends CommandUnknownOpts>(command: C, meta: CommandMeta): C {
  const errors = [...new Set<ErrorCode>(["usage_error", "internal_error", ...meta.errors])];
  registry.set(command, { ...meta, errors });
  const lines = [
    "",
    "Examples:",
    ...meta.examples.map((example) => `  $ ${example}`),
    "",
    `Errors: ${errors.join(", ")}`,
    "Output: JSON when piped or with --json: { ok, data, summary?, next? } on stdout; failures as { ok: false, error } on stderr",
  ];
  command.addHelpText("after", lines.join("\n"));
  return command;
}

export function metaOf(command: object): CommandMeta | undefined {
  return registry.get(command);
}
