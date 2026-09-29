import type { Command } from "@commander-js/extra-typings";
import { getOnboardingFacts, listSources, type OnboardingStep, type Source } from "@datin/api-client";
import { describe, type Finish } from "../define-command.ts";
import { apiErrors } from "../lib/errors.ts";
import { hashOf, readProfileFile, readState, sectionsOf } from "../lib/home.ts";
import { fromLocal } from "../lib/local.ts";
import { readDecisions, sourcesComplete } from "../lib/local-sources.ts";
import { errAsync, okAsync, ResultAsync } from "../lib/result.ts";

type StepState = "done" | "current" | "todo" | "unavailable";

interface Step {
  readonly id: OnboardingStep;
  readonly title: string;
  readonly state: StepState;
  readonly why: string;
  readonly next: string[];
}

interface Fact {
  readonly id: OnboardingStep;
  readonly title: string;
  readonly why: string;
  readonly next: string[];
  /** `undefined` means this version of datin cannot do the step yet. */
  readonly done: boolean | undefined;
}

/** The first step that is not done becomes `current`; nothing here is stored, it is all worked out from facts. */
function toSteps(facts: Fact[]): Step[] {
  let currentTaken = false;
  return facts.map(({ done, ...fact }) => {
    if (done === undefined) return { ...fact, state: "unavailable", next: [] };
    if (done) return { ...fact, state: "done", next: [] };
    if (currentTaken) return { ...fact, state: "todo", next: [] };
    currentTaken = true;
    return { ...fact, state: "current" };
  });
}

const LATER = "Arrives in a later version of datin; skip it for now";

export function registerOnboarding(program: Command, finish: Finish): void {
  const onboarding = program.command("onboarding").description("Where the user is in setting up datin");

  describe(
    onboarding
      .command("status")
      .description(
        "Every onboarding step with its state and the exact next command. Check at milestones, not after every answer",
      )
      .action(() =>
        finish(
          (context) =>
            fromLocal(
              Promise.all([
                context.token(),
                readState(context.deps.env),
                readProfileFile(context.deps.env),
                readDecisions(context.deps.env),
              ]),
              "read the local datin state",
            ).andThen(([resolved, state, draft, decisions]) => {
              const server = resolved.token
                ? context
                    .authed()
                    .andThen((api) => api.call((client) => getOnboardingFacts({ client })))
                    .map(({ data }) => data)
                    // A dead token reads as "not logged in" rather than failing the whole report.
                    .orElse((error) => (error.code === "auth_required" ? okAsync(undefined) : errAsync(error)))
                : okAsync(undefined);

              return ResultAsync.combine([
                server,
                context.api
                  .call((client) => listSources({ client }))
                  .map(({ data }): readonly Source[] | undefined => data.sources)
                  // Offline, the rest of the report still stands; the sources step just cannot be judged.
                  .orElse(() => okAsync(undefined)),
              ]).map(([facts, sources]) => {
                const loggedIn = facts !== undefined;
                const draftHasContent =
                  draft !== undefined && [...sectionsOf(draft).values()].some((body) => body.length > 0);
                const pushed =
                  Boolean(facts?.profile.exists) &&
                  facts?.profile.version === state.version &&
                  draft !== undefined &&
                  hashOf(draft) === state.syncedHash;
                const steps = toSteps([
                  {
                    id: "model_check",
                    title: "Check the agent's model",
                    why: "Building a good profile needs a strong model",
                    next: ["datin models check --model <your exact model id> --json"],
                    done: state.modelChecked,
                  },
                  {
                    id: "login",
                    title: "Log in",
                    why: "datin needs to know whose profile this is",
                    next: ["datin login --no-wait --json"],
                    done: loggedIn,
                  },
                  {
                    id: "sources",
                    title: "Go through the data sources with the user: ask, then read the ones they agree to",
                    why: "To draft datin.md for them. Every source needs a yes first; a no is fine and is recorded too",
                    next: ["datin sources list --json"],
                    done: sources !== undefined && sourcesComplete(sources, decisions),
                  },
                  {
                    id: "interview",
                    title: "Ask what the sources did not answer",
                    why: "To fill the form for them",
                    next: [],
                    done: undefined,
                  },
                  {
                    id: "draft",
                    title: "Fill in datin.md with the user",
                    why: "This file is the profile. Its `##` sections are fixed; only fill in what is under them",
                    next: ["datin profile template --write", "datin location suggest  (only after the user agrees)"],
                    done: draftHasContent || Boolean(facts?.profile.exists),
                  },
                  {
                    id: "push",
                    title: "Review the file with the user, then push it",
                    why: "Only a file the user has read and confirmed is uploaded",
                    next: ["datin profile push --agent-model <your model id>"],
                    done: pushed,
                  },
                  {
                    id: "contacts",
                    title: "Add how a match can reach the user",
                    why: "datin has no chat; after a mutual like both people get each other's contact",
                    next: ['datin contacts set --telegram "<handle>"'],
                    done: (facts?.contacts.kinds.length ?? 0) > 0,
                  },
                  {
                    id: "schedule",
                    title: "Set up a recurring check for recommendations",
                    why: "Create or verify a recurring task using your harness's scheduler on this machine, then record its job id or path. The confirm command does not create a task",
                    next: ['datin schedule confirm --every 3h --job "<scheduler job id or path>"'],
                    done: state.schedule !== undefined && state.scheduleJob !== undefined,
                  },
                  {
                    id: "recommendations",
                    title: "See the first recommendations",
                    why: "The point of all this. People who pass the mutual rules (seeking, age range), ranked by the judge; like or pass each one with the user",
                    next: ["datin recs list --json"],
                    done: state.recsSeen,
                  },
                ]).map((step) => (step.state === "unavailable" ? { ...step, why: LATER } : step));

                const current = steps.find((step) => step.state === "current");
                // Also observe restored profiles and changes made outside this CLI invocation.
                context.trackOnboarding(...steps.filter((step) => step.state === "done").map((step) => step.id));
                return {
                  data: { complete: current === undefined, current: current?.id ?? null, steps },
                  summary: current ? `Next: ${current.title}` : "Onboarding is complete for this version of datin",
                  ...(current && {
                    next: current.next.map((command) => ({
                      command,
                      ...(current.id === "schedule" && {
                        when: "only after creating or verifying an active local recurring task",
                      }),
                    })),
                  }),
                };
              });
            }),
          ({ data, summary }) =>
            [
              ...(data.complete ? [summary] : []),
              ...data.steps.map(
                (step) =>
                  `${{ done: "[x]", current: "[>]", todo: "[ ]", unavailable: "[-]" }[step.state]} ${step.title}`,
              ),
            ]
              .filter(Boolean)
              .join("\n"),
        ),
      ),
    { examples: ["datin onboarding status --json"], errors: [...apiErrors, "account_disabled", "local_state_error"] },
  );
}
