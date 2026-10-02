import { Command, CommanderError, type CommandUnknownOpts, InvalidArgumentError } from "@commander-js/extra-typings";
import type { OnboardingStep, UsageError } from "@datin/api-client";
import { registerAccount } from "./commands/account.ts";
import { registerAgent } from "./commands/agent.ts";
import { registerAuth } from "./commands/auth.ts";
import { registerCommands } from "./commands/commands.ts";
import { registerDoctor } from "./commands/doctor.ts";
import { registerFeedback } from "./commands/feedback.ts";
import { registerModels } from "./commands/models.ts";
import { registerOnboarding } from "./commands/onboarding.ts";
import { registerProfile } from "./commands/profile.ts";
import { registerRecs } from "./commands/recs.ts";
import { registerSafety } from "./commands/safety.ts";
import { registerSources } from "./commands/sources.ts";
import { registerTelemetry } from "./commands/telemetry.ts";
import { registerTerms } from "./commands/terms.ts";
import type { Context, Deps } from "./context.ts";
import type { Finish } from "./define-command.ts";
import { createApi, createRawClient, DEFAULT_API_URL } from "./lib/api.ts";
import { resolveToken } from "./lib/credentials/token.ts";
import { type DatinError, exitCodes, localError } from "./lib/errors.ts";
import { fromLocal } from "./lib/local.ts";
import { chooseMode, Output } from "./lib/output.ts";
import { errAsync, okAsync } from "./lib/result.ts";
import { type CommandRun, report } from "./lib/telemetry.ts";

/** `--json` has to be known before parsing, because a parse failure is itself reported in the chosen mode. */
function wantsJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

export interface RunState {
  onboarding?: OnboardingStep[];
  exitCode: number;
  errorCode: string | undefined;
  /** Filled in just before a command's action runs; stays undefined when parsing never got that far. */
  ran: Pick<CommandRun, "command" | "flags"> | undefined;
  /** What was wrong with a command line that could not be parsed. */
  usageError?: UsageError;
}

/** Commander's parse failures, under the names telemetry may send; anything else is `other`. */
const USAGE_ERRORS: Readonly<Record<string, UsageError>> = {
  "commander.unknownCommand": "unknown_command",
  "commander.unknownOption": "unknown_option",
  "commander.missingArgument": "missing_argument",
  "commander.optionMissingArgument": "missing_option_value",
  "commander.missingMandatoryOptionValue": "missing_required_option",
  "commander.help": "missing_subcommand",
  "commander.invalidArgument": "invalid_argument",
  "commander.excessArguments": "excess_arguments",
  "commander.conflictingOption": "conflicting_options",
};

/** A command's path below the program, such as `recs like`; empty for the program itself. */
function commandPath(command: CommandUnknownOpts): string {
  const names: string[] = [];
  for (let at: CommandUnknownOpts | null = command; at?.parent; at = at.parent) names.unshift(at.name());
  return names.join(" ");
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * What an unattended run (a scheduled check, `DATIN_UNATTENDED=1`) may do: read updates, acknowledge them, and
 * look at its own status. Other people's card text reaches that run, so anything that likes, passes, blocks,
 * edits or deletes is refused before a request is made, whatever the text asks for.
 */
const UNATTENDED_COMMANDS = new Set([
  "check",
  "onboarding status",
  "whoami",
  "auth status",
  "doctor",
  "commands",
  "agent instructions",
]);

const unattended = (env: Readonly<Record<string, string | undefined>>) => {
  const value = env.DATIN_UNATTENDED?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
};

/** A full URL, over https unless it is this machine: the login token must never cross a network in the clear. */
function apiUrl(value: string): string {
  if (!URL.canParse(value)) throw new InvalidArgumentError("It has to be a full URL such as http://localhost:8787");
  const { protocol, hostname } = new URL(value);
  if (protocol === "https:" || (protocol === "http:" && LOOPBACK_HOSTS.has(hostname))) return value;
  throw new InvalidArgumentError("It has to use https, or plain http to this machine such as http://localhost:8787");
}

export function createProgram(deps: Deps, state: RunState) {
  const program = new Command()
    .name("datin")
    .description("The client your AI agent uses to find you a date")
    .version(deps.version, "-v, --version")
    .option("--json", "print JSON even in a terminal (always on when output is piped)", false)
    .option("--token <token>", "use this login token instead of the stored one (or set DATIN_TOKEN)")
    .option("--api-url <url>", "talk to another API, e.g. a local one", apiUrl, DEFAULT_API_URL)
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => deps.stdout.write(text),
      // Parse errors are reported once, as a typed error, by `run`.
      writeErr: () => {},
    });

  const finish: Finish = async (handler, render) => {
    const flags = program.opts();
    const outputMode = chooseMode(flags, deps.stdoutIsTTY);
    const output = new Output(outputMode, deps.stdout, deps.stderr, {
      apiUrl: flags.apiUrl !== DEFAULT_API_URL ? flags.apiUrl : undefined,
      json: flags.json,
    });
    const apiOptions = {
      baseUrl: flags.apiUrl,
      fetch: deps.fetch,
      userAgent: `datin/${deps.version}`,
      pause: (seconds: number) => {
        output.notify("waiting", { seconds }, `The API asked for a short pause; trying again in ${seconds} s`);
        return deps.sleep(seconds * 1000);
      },
    };
    const credentials = deps.openCredentialStore();
    const token = () =>
      resolveToken({ flag: flags.token, env: deps.env, account: new URL(flags.apiUrl).origin }, credentials);
    const withToken = (value: string) => createApi({ ...apiOptions, token: value });
    const context: Context = {
      deps,
      apiUrl: flags.apiUrl,
      outputMode,
      api: createApi(apiOptions),
      token,
      credentials,
      trackOnboarding: (...steps) => {
        state.onboarding = [...new Set([...(state.onboarding ?? []), ...steps])];
      },
      notify: (event, fields, text) => output.notify(event, fields, text),
      withToken,
      authed: () =>
        fromLocal(token(), "read the stored login").andThen((resolved) =>
          resolved.token
            ? okAsync(withToken(resolved.token))
            : errAsync<never, DatinError>({
                code: "auth_required",
                message: "You are not logged in",
                hint: "Run `datin login`",
                retryable: false,
                next: [{ command: "datin login --no-wait --json" }],
              }),
        ),
    };
    const command = state.ran?.command ?? "";
    const result =
      unattended(deps.env) && !UNATTENDED_COMMANDS.has(command)
        ? await errAsync<never, DatinError>(
            localError("unattended_refused", `\`datin ${command}\` is not allowed in an unattended run`, {
              hint: "DATIN_UNATTENDED is set, so only `datin check`, `datin check --ack` and status commands run. Ask the user in a live session instead",
              details: { command, allowed: [...UNATTENDED_COMMANDS] },
            }),
          )
        : await handler(context);
    result.match(
      (value) => output.success(value, render),
      (error) => {
        output.failure(error);
        state.exitCode = exitCodes[error.code];
        state.errorCode = error.code;
      },
    );
  };

  // Commander never runs a default through the option's parser, so `DATIN_API_URL` is checked here, as a
  // usage error, before any command can send a request (or the token) to it.
  program.hook("preAction", () => {
    const fromEnv = deps.env.DATIN_API_URL;
    if (!fromEnv || program.getOptionValueSource("apiUrl") !== "default") return;
    try {
      program.setOptionValueWithSource("apiUrl", apiUrl(fromEnv), "env");
    } catch (error) {
      if (error instanceof InvalidArgumentError) throw new InvalidArgumentError(`DATIN_API_URL: ${error.message}`);
      throw error;
    }
  });

  // Flag names only, from both the command and the global options, and only the ones actually typed.
  program.hook("preAction", (_root, action) => {
    const typed = [program, action].flatMap((command) =>
      command.options
        .filter((option) => command.getOptionValueSource(option.attributeName()) === "cli")
        .map((option) => option.attributeName()),
    );
    state.ran = { command: commandPath(action), flags: [...new Set(typed)].sort() };
  });

  registerAuth(program, finish);
  registerOnboarding(program, finish);
  registerProfile(program, finish);
  registerAccount(program, finish);
  registerRecs(program, finish);
  registerSources(program, finish);
  registerFeedback(program, finish);
  registerSafety(program, finish);
  registerTerms(program, finish);
  registerAgent(program, finish);
  registerTelemetry(program, finish);
  registerModels(program, finish);
  registerDoctor(program, finish);
  registerCommands(program, finish);
  return program;
}

/** Use Commander's parsed operands so global options before a group do not hide its name. */
function commandNamedBy(program: Command): Command {
  let current: Command = program;
  for (;;) {
    const word = current.args[0];
    if (word === undefined) break;
    const child = current.commands.find((candidate) => candidate.name() === word || candidate.aliases().includes(word));
    if (!child) break;
    current = child as Command;
  }
  return current;
}

function usageError(program: Command, error: CommanderError): DatinError {
  // Commander reports "this command needs a subcommand" by printing help and throwing a placeholder message.
  if (error.code === "commander.help") {
    const group = commandNamedBy(program);
    const path = [...(group === program ? [] : [group.name()])].join(" ");
    const choices = group.commands.map((command) => command.name());
    return localError("usage_error", `\`datin${path ? ` ${path}` : ""}\` needs a subcommand: ${choices.join(", ")}`, {
      hint: "Run `datin commands --json` for every command with its options and examples",
      details: { subcommands: choices },
      next: [{ command: "datin commands --json" }],
    });
  }
  return localError("usage_error", error.message.replace(/^error: /, ""), {
    hint: "Run `datin --help` or `datin commands --json` to see what is available",
  });
}

/** Runs the CLI once and returns the exit code; never calls `process.exit`, so output always drains. */
export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  const state: RunState = { exitCode: 0, errorCode: undefined, ran: undefined };
  const program = createProgram(deps, state);
  const startedAt = deps.now().getTime();
  if (argv.length === 0) {
    // Typed with nothing after it, datin introduces itself; that is not a mistake.
    deps.stdout.write(program.helpInformation());
    return 0;
  }
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    // --help and --version end parsing through the same exception, with exit code 0.
    if (error.exitCode === 0) return 0;
    const flags = program.opts();
    const json = wantsJson(argv);
    new Output(chooseMode({ json }, deps.stdoutIsTTY), deps.stdout, deps.stderr, {
      apiUrl: flags.apiUrl !== DEFAULT_API_URL ? flags.apiUrl : undefined,
      json,
    }).failure(usageError(program, error));
    state.exitCode = exitCodes.usage_error;
    state.errorCode = "usage_error";
    state.usageError = USAGE_ERRORS[error.code] ?? "other";
    // As far as parsing got, in datin's own command names: the words that were typed are never reported.
    state.ran ??= { command: commandPath(commandNamedBy(program)) || "(not recognised)", flags: [] };
  }

  const ran = state.ran ?? { command: "(not recognised)", flags: [] };
  // Confirmation previews must not create config or send requests before the user agrees.
  if (!ran.command.startsWith("telemetry") && state.errorCode !== "confirmation_required") {
    const client = createRawClient({
      baseUrl: program.opts().apiUrl,
      fetch: deps.fetch,
      userAgent: `datin/${deps.version}`,
    });
    await report(deps, client, {
      ...ran,
      onboarding: state.onboarding,
      ok: state.exitCode === 0,
      errorCode: state.errorCode,
      usageError: state.usageError,
      durationMs: deps.now().getTime() - startedAt,
    });
  }
  return state.exitCode;
}
