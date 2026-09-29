import type { NextCommand } from "@datin/api-client";
import { type DatinError, dailyLimitOf } from "./errors.ts";

/** "3 h 12 min", "4 min", "20 s": precise enough to plan around, never a raw second count. */
function formatWait(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export interface Writer {
  write(text: string): void;
}

export type OutputMode = "json" | "human";

/** What a command hands back on success. `data` is the contract; the rest helps whoever reads it. */
export interface CommandOutput<Data> {
  readonly data: Data;
  readonly summary?: string;
  readonly next?: NextCommand[];
}

/**
 * Code points a reader's terminal or eye acts on rather than reads: C0 controls other than tab and line
 * feed, DEL and C1 (erase the screen, rewrite a line, set the title), text-direction overrides, and
 * Unicode tag characters that people cannot see but models read. Cards and contacts are other people's
 * words, so they never reach a terminal or an agent as any of these.
 */
function isActive(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

/** Terminal text: active code points become a visible replacement mark. */
export function forTerminal(text: string): string {
  let out = "";
  for (const character of text) out += isActive(character.codePointAt(0) ?? 0) ? "\uFFFD" : character;
  return out;
}

/**
 * JSON text: `JSON.stringify` escapes C0 controls but leaves DEL, C1, direction overrides and tag
 * characters literal, so those are written as `\u` escapes too. Parsing gives back the exact value.
 */
export function toJson(value: unknown): string {
  let out = "";
  for (const character of JSON.stringify(value)) {
    if (!isActive(character.codePointAt(0) ?? 0)) {
      out += character;
      continue;
    }
    for (let i = 0; i < character.length; i++) out += `\\u${character.charCodeAt(i).toString(16).padStart(4, "0")}`;
  }
  return out;
}

/** JSON whenever a machine is reading: asked for explicitly, or stdout is not a terminal. */
export function chooseMode(flags: { json: boolean }, stdoutIsTTY: boolean): OutputMode {
  return flags.json || !stdoutIsTTY ? "json" : "human";
}

/** JSON is one stdout document; terminal results have one renderer. Progress and next steps use stderr. */
export class Output {
  constructor(
    private readonly mode: OutputMode,
    private readonly stdout: Writer,
    private readonly stderr: Writer,
    private readonly context: { apiUrl?: string; json?: boolean } = {},
  ) {}

  /** Only Datin hints inherit safe globals; credentials and external commands are never copied. */
  private next(steps: NextCommand[] | undefined): NextCommand[] | undefined {
    return steps?.map((step) => {
      if (!step.command.startsWith("datin ")) return step;
      const flags: string[] = [];
      if (this.context.apiUrl && !/(?:^|\s)--api-url(?:[=\s]|$)/.test(step.command)) {
        const quoted = `'${this.context.apiUrl.replaceAll("'", "'\\''")}'`;
        flags.push(`--api-url ${quoted}`);
      }
      if (this.context.json && !/(?:^|\s)--json(?:\s|$)/.test(step.command)) flags.push("--json");
      return flags.length ? { ...step, command: `datin ${flags.join(" ")} ${step.command.slice(6)}` } : step;
    });
  }

  success<Data>(output: CommandOutput<Data>, render?: (output: CommandOutput<Data>) => string): void {
    const next = this.next(output.next);
    if (this.mode === "json") {
      this.stdout.write(`${toJson({ ok: true, ...output, ...(next && { next }) })}\n`);
      return;
    }
    const body = render ? render(output) : (output.summary ?? JSON.stringify(output.data, null, 2));
    if (body) this.stdout.write(`${forTerminal(body)}\n`);
    for (const step of next ?? [])
      this.stderr.write(forTerminal(`next: ${step.command}${step.when ? `  (${step.when})` : ""}\n`));
  }

  /** A progress line on stderr: one JSON object per line for machines, plain text for people. */
  notify(event: string, fields: Record<string, unknown>, text: string): void {
    this.stderr.write(this.mode === "json" ? `${toJson({ event, ...fields })}\n` : `${forTerminal(text)}\n`);
  }

  failure(error: DatinError): void {
    const next = this.next(error.next);
    if (this.mode === "json") {
      const { next: _next, ...rest } = error;
      this.stderr.write(`${toJson({ ok: false, error: rest, ...(next && { next }) })}\n`);
      return;
    }
    this.stderr.write(forTerminal(`error: ${error.message} [${error.code}]\n`));
    const limit = dailyLimitOf(error);
    if (limit) {
      const wait = error.details?.retry_after_seconds;
      const again = typeof wait === "number" ? `, try again in ${formatWait(wait)}` : "";
      this.stderr.write(forTerminal(`limit: daily ${limit.replace("_", " ")}${again}\n`));
    }
    if (error.hint) this.stderr.write(forTerminal(`hint: ${error.hint}\n`));
    for (const step of next ?? [])
      this.stderr.write(forTerminal(`next: ${step.command}${step.when ? `  (${step.when})` : ""}\n`));
  }
}
