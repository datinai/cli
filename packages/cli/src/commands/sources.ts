import { join } from "node:path";
import type { Command } from "@commander-js/extra-typings";
import type { Source } from "@datin/api-client";
import { fetchXPosts, listSources } from "@datin/api-client";
import type { Context } from "../context.ts";
import { describe, type Finish } from "../define-command.ts";
import { apiErrors, authedErrors, type DatinError, localError } from "../lib/errors.ts";
import { fromLocal } from "../lib/local.ts";
import {
  evidenceDir,
  extractionPrompt,
  historiesNotHere,
  markStatus,
  measure,
  onThisMachine,
  readDecisions,
  recordDecision,
  sourcesComplete,
} from "../lib/local-sources.ts";
import { errAsync, okAsync, type ResultAsync } from "../lib/result.ts";

const CONNECTED = ["x"] as const;
const unknownSource = (id: string) =>
  errAsync(
    localError("usage_error", `\`${id}\` is not a source datin can connect`, {
      hint: `Connected sources: ${CONNECTED.join(", ")}`,
      next: [{ command: "datin sources list --json" }],
    }),
  );

const evidencePath = (context: Context, id: string) => join(evidenceDir(context.deps.env), `${id}.md`);

const consentCommand = (id: string) => `datin sources consent ${id} --granted`;

type KnownSource = { readonly source: Source; readonly catalogue: readonly Source[] };

function knownSource(context: Context, id: string): ResultAsync<KnownSource, DatinError> {
  return context.api
    .call((client) => listSources({ client }))
    .andThen(({ data }) => {
      const source = data.sources.find((candidate) => candidate.id === id);
      return source
        ? okAsync({ source, catalogue: data.sources })
        : errAsync(
            localError("usage_error", `\`${id}\` is not a datin source`, {
              next: [{ command: "datin sources list --json" }],
            }),
          );
    });
}

/** Every local read needs an enabled source and consent to its current wording. */
function allowed(context: Context, id: string): ResultAsync<KnownSource, DatinError> {
  return knownSource(context, id).andThen((known) => {
    const { source } = known;
    if (!source.enabled) {
      return errAsync<KnownSource, DatinError>({
        code: "source_disabled",
        message: `The ${source.title} source is switched off right now`,
        hint: "Continue with the other sources; run `datin sources list` later to see if it is back",
        retryable: true,
        details: { source: id, reason: source.disabled_reason },
      });
    }
    return fromLocal(readDecisions(context.deps.env), "read the source decisions on this machine").andThen(
      (decisions) => {
        const decision = decisions[id];
        if (decision?.consent === "granted" && decision.consentVersion === source.consent.version)
          return okAsync(known);
        return errAsync<KnownSource, DatinError>({
          code: "consent_required",
          message:
            decision?.consent === "declined"
              ? `The user said no to ${source.title}`
              : `${source.title} needs the user's yes first`,
          hint: `Tell the user all three, then ask. What: ${source.consent.what}. Why: ${source.consent.why}. Where it goes: ${source.consent.goes_where}. A no is a fine answer; record it with --declined and move on`,
          retryable: false,
          details: { source: id, consent: source.consent },
          next: [
            { command: consentCommand(id), when: "only after the user said yes" },
            { command: `datin sources consent ${id} --declined`, when: "if the user said no" },
          ],
        });
      },
    );
  });
}

export function registerSources(program: Command, finish: Finish): void {
  const sources = program
    .command("sources")
    .description("Where your agent may look, with your consent, to fill in datin.md for you");

  describe(
    sources
      .command("list")
      .description(
        "Every data source, whether it is switched on right now, what to tell the user before using it, and for agent histories whether they are on this machine (it only checks that their folder exists)",
      )
      .action(() =>
        finish(
          (context) =>
            context.api
              .call((client) => listSources({ client }))
              .andThen(({ data }) =>
                fromLocal(
                  Promise.all([
                    Promise.all(
                      data.sources.map(async (source) => {
                        const here = await onThisMachine(source.id, context.deps.env);
                        return here === undefined ? source : { ...source, on_this_machine: here };
                      }),
                    ),
                    readDecisions(context.deps.env),
                  ]),
                  "check which agent histories are on this machine",
                ).map(([sources, decisions]) => {
                  const notHere = new Set(
                    sources.filter((s) => "on_this_machine" in s && !s.on_this_machine).map((s) => s.id),
                  );
                  // With nothing on this machine to ask about, the sources step is already done.
                  if (sourcesComplete(data.sources, decisions, notHere)) context.trackOnboarding("sources");
                  return { data: { sources } };
                }),
              ),
          ({ data }) =>
            data.sources
              .map(
                (source) =>
                  `${source.enabled ? "on " : "off"} ${source.id} (${source.kind})${source.disabled_reason ? `: ${source.disabled_reason}` : ""}${"on_this_machine" in source && !source.on_this_machine ? " — not on this machine" : ""}`,
              )
              .join("\n"),
        ),
      ),
    { examples: ["datin sources list --json"], errors: [...apiErrors] },
  );

  describe(
    sources
      .command("consent")
      .argument("<source>", "source id from `datin sources list`")
      .option("--granted", "the user said yes, just now, after hearing what, why and where it goes")
      .option("--declined", "the user said no")
      .description("Record the user's answer for one source. Nothing reads a source before a yes is recorded here")
      .action((source, options) =>
        finish((context) => {
          if (Boolean(options.granted) === Boolean(options.declined)) {
            return errAsync(localError("usage_error", "Pass exactly one of --granted or --declined"));
          }
          return knownSource(context, source).andThen(({ source: known, catalogue }) => {
            const consent = options.granted ? ("granted" as const) : ("declined" as const);
            return fromLocal(
              recordDecision(
                context.deps.env,
                source,
                {
                  consent,
                  consentVersion: known.consent.version,
                  ...(consent === "declined" && { status: "skipped" as const }),
                },
                context.deps.now(),
              ),
              "save the user's answer on this machine",
            )
              .andThen(() =>
                fromLocal(
                  Promise.all([readDecisions(context.deps.env), historiesNotHere(catalogue, context.deps.env)]),
                  "read source completion",
                ),
              )
              .map(([decisions, notHere]) => {
                if (sourcesComplete(catalogue, decisions, notHere)) context.trackOnboarding("sources");
                return {
                  data: { source, consent, consent_version: known.consent.version },
                  summary:
                    consent === "granted"
                      ? `Recorded: the user agreed to ${known.title}`
                      : `Recorded: the user declined ${known.title}. Do not read it`,
                  ...(consent === "granted" && {
                    next: [
                      known.kind === "connected"
                        ? { command: `datin sources connect ${source}` }
                        : { command: `datin sources prompt ${source} --json` },
                    ],
                  }),
                };
              });
          });
        }),
      ),
    {
      examples: ["datin sources consent claude-history --granted", "datin sources consent x --declined"],
      errors: [...apiErrors, "local_state_error"],
    },
  );

  describe(
    sources
      .command("detect")
      .argument("<source>", "a local source id, e.g. codex-history")
      .description(
        "Where a local source lives on this machine, how big it is and how to read it. Counts files; never opens them. Needs the user's yes",
      )
      .action((source) =>
        finish((context) =>
          allowed(context, source).andThen(({ source: known }) =>
            fromLocal(measure(source, context.deps.env), "look at the source's folder").map((measured) => ({
              data: {
                source,
                title: known.title,
                ...(measured ?? {
                  present: false,
                  note: "This source has no fixed location; the agent reads it with its own tools",
                }),
              },
              summary: measured?.present
                ? `${measured.files} files, ${Math.round(measured.bytes / 1_000_000)} MB`
                : "Nothing found for this source on this machine",
              next: [
                measured?.present === false
                  ? { command: `datin sources skip ${source}` }
                  : { command: `datin sources prompt ${source} --json` },
              ],
            })),
          ),
        ),
      ),
    {
      examples: ["datin sources detect claude-history --json"],
      errors: [...apiErrors, "consent_required", "source_disabled", "local_state_error"],
    },
  );

  describe(
    sources
      .command("prompt")
      .argument("<source>", "a local source id")
      .description(
        "The instructions for reading one local source and where to write the evidence. Needs the user's yes",
      )
      .action((source) =>
        finish(
          (context) =>
            allowed(context, source).map(({ source: known }) => ({
              data: {
                source,
                evidence_path: evidencePath(context, source),
                prompt: extractionPrompt(source, known.title, evidencePath(context, source)),
              },
              summary: "Prepare all selected source prompts, then launch their readers together as the skill describes",
            })),
          ({ data, summary }) => [summary, data.prompt].filter(Boolean).join("\n\n"),
        ),
      ),
    {
      examples: ["datin sources prompt claude-history --json"],
      errors: [...apiErrors, "consent_required", "source_disabled", "local_state_error"],
    },
  );

  for (const [name, status, text] of [
    ["done", "done", "Record that a source has been read and its evidence file written"],
    ["skip", "skipped", "Record that a source is being skipped, for example because it is not on this machine"],
  ] as const) {
    describe(
      sources
        .command(name)
        .argument("<source>", "source id")
        .description(text)
        .action((source) =>
          finish((context) =>
            (status === "done" ? allowed(context, source) : knownSource(context, source)).andThen(
              ({ source: known, catalogue }) =>
                fromLocal(
                  (async () => {
                    const decisions = await readDecisions(context.deps.env);
                    // An explicit skip records a decision for the current catalogue version.
                    if (decisions[source]?.consentVersion !== known.consent.version)
                      await recordDecision(
                        context.deps.env,
                        source,
                        { consent: "declined", consentVersion: known.consent.version },
                        context.deps.now(),
                      );
                    await markStatus(context.deps.env, source, status);
                    const notHere = await historiesNotHere(catalogue, context.deps.env);
                    if (sourcesComplete(catalogue, await readDecisions(context.deps.env), notHere))
                      context.trackOnboarding("sources");
                  })(),
                  "save the source's status on this machine",
                ).map(() => ({
                  data: { source, status },
                  summary: `Recorded ${source} as ${status}`,
                  next: [
                    {
                      command: "datin onboarding status --json",
                      when: "after all selected sources finish or are skipped",
                    },
                  ],
                })),
            ),
          ),
        ),
      {
        examples: [`datin sources ${name} claude-history`],
        errors: [...apiErrors, "consent_required", "source_disabled", "local_state_error"],
      },
    );
  }

  describe(
    sources
      .command("connect")
      .argument("<source>", "which source to connect, e.g. x")
      .description(
        "Where the user goes to connect an account. Connecting it there is what proves the account is theirs",
      )
      .action((source) =>
        finish((context) => {
          if (source !== "x") return unknownSource(source);
          // The website lives on the API's sibling origin: api.example.com → example.com.
          const site = new URL(context.apiUrl);
          site.hostname = site.hostname.replace(/^api\./, "");
          const url = new URL("/app/connections", site).toString();
          return okAsync({
            data: { source, url },
            summary: `Ask the user to open ${url} and connect X`,
            next: [{ command: "datin sources fetch x", when: "after the user says X is connected" }],
          });
        }),
      ),
    { examples: ["datin sources connect x --json"], errors: [] },
  );

  describe(
    sources
      .command("fetch")
      .argument("<source>", "which connected source to read, e.g. x")
      .option("--consented", "the user said yes to this source's consent text just now")
      .description(
        "Read from a connected source. For x: the user's own recent posts, passed through and not stored by datin",
      )
      .action((source, options) =>
        finish((context) => {
          if (source !== "x") return unknownSource(source);
          return context
            .authed()
            .andThen((api) =>
              api.call((client) => fetchXPosts({ client, body: { consented: Boolean(options.consented) } })),
            );
        }),
      ),
    {
      examples: ["datin sources fetch x --consented --json"],
      errors: [...authedErrors, "consent_required", "source_disabled", "not_found", "reconnect_required"],
    },
  );
}
