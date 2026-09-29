import type { Command } from "@commander-js/extra-typings";
import { getProfile, getProfileTemplate, saveProfile } from "@datin/api-client";
import type { Context } from "../context.ts";
import { describe, type Finish } from "../define-command.ts";
import { apiErrors, authedErrors, type DatinError, localError } from "../lib/errors.ts";
import {
  hashOf,
  profilePath,
  readProfileFile,
  readState,
  sectionsOf,
  updateState,
  writeProfileFile,
} from "../lib/home.ts";
import { fromLocal } from "../lib/local.ts";
import { readEvidenceSnapshot } from "../lib/local-sources.ts";
import { err, ok } from "../lib/result.ts";

const safe = <T>(promise: Promise<T>) => fromLocal(promise, "read or write the local datin.md");

const serverProfile = (context: Context) =>
  context.authed().andThen((api) => api.call((client) => getProfile({ client })));

const noLocalFile = (context: Context): DatinError =>
  localError("usage_error", `There is no ${profilePath(context.deps.env)} yet`, {
    hint: "Create it from the template, or pull the saved profile",
    next: [{ command: "datin profile template --write" }, { command: "datin profile pull" }],
  });

export function registerProfile(program: Command, finish: Finish): void {
  const profile = program
    .command("profile")
    .description("Your datin.md: a form in markdown whose `##` sections are fixed");

  describe(
    profile
      .command("template")
      .description("The blank datin.md and what belongs under each heading")
      .option("--write", "also write the blank form to ~/.datin/datin.md if there is no file yet")
      .action((options) =>
        finish(
          (context) =>
            context.api
              .call((client) => getProfileTemplate({ client }))
              .andThen((template) =>
                safe(
                  (async () => {
                    const path = profilePath(context.deps.env);
                    const exists = (await readProfileFile(context.deps.env)) !== undefined;
                    if (options.write && !exists) await writeProfileFile(context.deps.env, template.data.markdown);
                    return {
                      ...template,
                      data: { ...template.data, path, written: Boolean(options.write) && !exists },
                      next: [
                        {
                          command: "datin profile push --agent-model <your model id>",
                          when: "after the user has reviewed and confirmed the filled-in file",
                        },
                      ],
                    };
                  })(),
                ),
              ),
          ({ data, summary }) => [summary, data.markdown].filter(Boolean).join("\n\n"),
        ),
      ),
    {
      examples: ["datin profile template --json", "datin profile template --write"],
      errors: [...apiErrors, "local_state_error"],
    },
  );

  describe(
    profile
      .command("show")
      .description("The profile as datin has it")
      .action(() => finish(serverProfile, ({ data }) => data.markdown)),
    { examples: ["datin profile show --json"], errors: [...authedErrors, "not_found"] },
  );

  describe(
    profile
      .command("pull")
      .description("Write the saved profile to ~/.datin/datin.md")
      .option("--yes", "overwrite local edits that were never pushed")
      .action((options) =>
        finish((context) =>
          serverProfile(context).andThen(({ data }) =>
            safe(Promise.all([readProfileFile(context.deps.env), readState(context.deps.env)])).andThen(
              ([local, state]) => {
                const unpushedEdits =
                  local !== undefined && local !== data.markdown && hashOf(local) !== state.syncedHash;
                if (unpushedEdits && !options.yes) {
                  return err(
                    localError(
                      "confirmation_required",
                      "The local datin.md has edits that were never pushed; pulling would overwrite them",
                      {
                        hint: "Look at `datin profile diff` first. Pass --yes to overwrite",
                        next: [
                          { command: "datin profile diff" },
                          {
                            command: "datin profile pull --yes",
                            when: "only if the user agrees to lose the local edits",
                          },
                        ],
                      },
                    ),
                  );
                }
                return safe(
                  (async () => {
                    await writeProfileFile(context.deps.env, data.markdown);
                    await updateState(context.deps.env, { version: data.version, syncedHash: hashOf(data.markdown) });
                    return {
                      data: { path: profilePath(context.deps.env), version: data.version },
                      summary: `Wrote version ${data.version} to ${profilePath(context.deps.env)}`,
                    };
                  })(),
                );
              },
            ),
          ),
        ),
      ),
    {
      examples: ["datin profile pull"],
      errors: [...authedErrors, "not_found", "confirmation_required"],
      destructive: true,
    },
  );

  describe(
    profile
      .command("push")
      .description("Save ~/.datin/datin.md. Only push a file the user has reviewed and confirmed")
      .option("--agent-model <id>", "the model you, the agent, are running (as your own system context states it)")
      .action((options) =>
        finish((context) =>
          safe(
            Promise.all([
              readProfileFile(context.deps.env),
              readState(context.deps.env),
              readEvidenceSnapshot(context.deps.env),
            ]),
          ).andThen(([markdown, state, evidence]) => {
            if (markdown === undefined) return err(noLocalFile(context));
            // Defaults to the model `datin models check` saw, so the agent need not repeat it.
            const agentModel = options.agentModel ?? state.agentModel;
            return context
              .authed()
              .andThen((api) =>
                api.call((client) =>
                  saveProfile({
                    client,
                    body: {
                      markdown,
                      base_version: state.version,
                      ...(agentModel && { agent_model: agentModel }),
                    },
                  }),
                ),
              )
              .andThen((saved) =>
                safe(
                  updateState(context.deps.env, {
                    version: saved.data.version,
                    syncedHash: hashOf(markdown),
                    syncedEvidenceHash: evidence.hash,
                  }),
                ).map(() => {
                  context.trackOnboarding("draft", "push");
                  return saved;
                }),
              );
          }),
        ),
      ),
    {
      examples: ["datin profile push --agent-model claude-fable-5-1"],
      errors: [...authedErrors, "validation_failed", "profile_conflict"],
    },
  );

  describe(
    profile
      .command("diff")
      .description("Which sections differ between ~/.datin/datin.md and the saved profile")
      .action(() =>
        finish(
          (context) =>
            safe(readProfileFile(context.deps.env)).andThen((local) => {
              if (local === undefined) return err(noLocalFile(context));
              return serverProfile(context).andThen(({ data }) => {
                const mine = sectionsOf(local);
                if ([...mine.values()].some((body) => body.length > 0)) context.trackOnboarding("draft");
                const theirs = sectionsOf(data.markdown);
                const changed = [...new Set([...mine.keys(), ...theirs.keys()])]
                  .filter((heading) => (mine.get(heading) ?? "") !== (theirs.get(heading) ?? ""))
                  .map((heading) => ({
                    section: heading,
                    local: mine.get(heading) ?? null,
                    saved: theirs.get(heading) ?? null,
                  }));
                return ok({
                  data: { in_sync: changed.length === 0, saved_version: data.version, changed },
                  summary:
                    changed.length === 0
                      ? "The local file matches the saved profile"
                      : `${changed.length} section(s) differ: ${changed.map((c) => c.section).join(", ")}`,
                });
              });
            }),
          ({ data }) =>
            data.in_sync
              ? "in sync"
              : data.changed
                  .map((c) => `## ${c.section}\n- saved: ${c.saved ?? "(missing)"}\n+ local: ${c.local ?? "(missing)"}`)
                  .join("\n\n"),
        ),
      ),
    { examples: ["datin profile diff --json"], errors: [...authedErrors, "not_found"] },
  );
}
