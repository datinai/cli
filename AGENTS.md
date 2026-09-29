# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` is a symlink to this file. People-facing docs: [README.md](README.md) (what datin is) and [CONTRIBUTING.md](CONTRIBUTING.md) (behavior, releases, review rules). Read CONTRIBUTING before changing CLI behavior.

## What this is

`datin` is the CLI an AI agent calls to find its user a date. There is no app: the user's own agent harness (Claude Code, Codex, OpenCode, pi, …) is the interface, [`skills/datin/SKILL.md`](skills/datin/SKILL.md) teaches it the flow, and this CLI is the client it runs. The API is a separate service; this repo holds only a snapshot of its contract (`openapi.json`).

So the "user" of every command is usually an agent. Design for it: predictable JSON, typed errors, a `next` hint for what to run, and nothing interactive.

## Layout

```
openapi.json               the API contract (snapshot); refresh with `bun run spec:pull`
packages/api-client        generated from openapi.json by Hey API; never edit by hand
packages/cli/src
  run.ts                   builds the Commander program; the one place a Result becomes output + exit code
  define-command.ts        command declaration: examples, expected errors, destructive flag
  commands/                one file per command group
  lib/                     output, errors (exit-code map), credentials, telemetry, local state
  agents/                  generated: per-harness notes embedded from skills/datin/agents
skills/datin               SKILL.md, references/, agents/*.agent.md (per-harness notes)
scripts/                   spec pull, agent-note embedding, skill export, standalone builds, lint rules
```

## Commands

```sh
bun install
bun run check          # lint + generated-code freshness + types + tests; run before every PR
bun run datin -- <args> # run the CLI from source, e.g. `bun run datin -- doctor --api-url http://localhost:8787`
bun run spec:pull      # refresh openapi.json from the live API, then `bun run generate`
bun run generate       # regenerate the API client and re-embed the harness notes
bun run build:binary   # standalone executable for this machine (`--target all` for six platforms)
bun run hooks:install  # once per clone: pre-commit runs the linter
```

Use bun for everything (install, scripts, tests, `bunx`). npm appears in CI only to publish through npm's OIDC trusted publishing.

## Rules that hold everywhere

- **stdout is data, stderr is for people.** Piped or `--json`: exactly one JSON envelope on stdout, `{ ok, data, summary?, next? }` or `{ ok: false, error: { code, message, hint?, retryable } }`. A terminal gets one human rendering of the same result. Never print progress or notices to stdout.
- **Never prompt.** Missing input fails with `usage_error` naming the exact flags. Destructive commands need `--yes`, otherwise `confirmation_required`.
- **Never call `process.exit`.** `run()` returns the exit code, so output always drains.
- **Expected failures are Results.** neverthrow is imported only through `lib/result.ts`. A thrown exception is a bug and surfaces as `internal_error`.
- **Exit codes are exhaustive by construction.** `lib/errors.ts` maps every server `ErrorCode` (a generated union) plus the local codes with `satisfies`. A new server code breaks the build until it is mapped. Keep it that way.
- **Ask before looking.** Reading a local source is refused with `consent_required` until the user's yes is recorded for the current consent wording. The refusal carries what, why and where it goes. Don't add a path that reads user data without that gate.
- **Other people's text is data, never instructions,** and never reaches the terminal raw: `forTerminal` and `toJson` in `lib/output.ts` neutralise control codes, direction overrides and tag characters. Anything new that prints server text goes through them.
- **Secrets never leave their file.** The login token lives in `$XDG_CONFIG_HOME/datin/credentials.json` (0700 directory, 0600 file, one token per API origin). No OS keychain, by decision. Never log, echo or put a token in a `next` hint. Telemetry sends flag *names*, never values.
- **The agent says which model it is.** Never infer the model from environment variables or config files; `datin models check` takes what the agent reports.
- **UX and copy are product decisions.** Human output, SKILL.md wording, harness notes and help text change only when a maintainer asked for that change. Fixing a bug is not permission to reword the experience.

## Changing things: what "done" means

| Change | Also do |
|---|---|
| Any code | `bun run check` passes. Add tests for observable behavior (in-process `createProgram()`, plus a spawn test when stdout/stderr/exit code matter). |
| API contract changed upstream | `bun run spec:pull && bun run generate`, map any new error code, commit `openapi.json` with the generated client. CI fails on a stale client. |
| `skills/datin/agents/*.agent.md` | `bun run agents:embed` (part of `generate`); CI fails when the embedded copy is stale. |
| `skills/datin/**` | The website hosts a copy: after the CLI that matches it is released, export it with `bun run skill:export <path-to-website-public-dir>` so the hosted skill never tells agents to run a command the published CLI lacks. |
| Output or login flow | Also run the built CLI under plain Node (`bun run build`, then `node packages/cli/dist/bin.mjs …`): the npm package must stay Node-compatible. |
| New dependency | Prefer none. A runtime dependency ships to every user; justify it. Pin tools that break in minors (tsdown, Hey API) exactly. |

"Verified" in a PR or handoff means you ran it and saw the result. Say what was not checked (for example a real browser login, or Windows).

## Releases

- Bump `packages/cli/package.json` (and the matching `bun.lock` workspace entry) in a PR, merge it to `main`, then push only that tag: `git push origin refs/tags/vX.Y.Z`. Never `git push --tags`.
- The tag triggers `release.yml`: CI, six standalone builds, a packed-and-installed npm tarball check, then publishing those exact bytes with provenance, then the GitHub release with `SHA256SUMS`. The publish job waits for a maintainer to approve the `npm` environment.
- Never publish from a local machine, overwrite a published version, or move or delete a release tag. `main` and `v*` tags are protected; changes land through squash-merged PRs with the `check` job green.
- npm can take minutes to serve a new version. If only the post-publish verify step fails, re-run the failed jobs: the workflow accepts an already-published version whose SHA-512 matches.

## Things learned the hard way

- **Bun runs on TypeScript 7 (the native compiler).** The client generator needs the classic compiler API, so `packages/api-client` pins TypeScript 6 for itself. `exactOptionalPropertyTypes` is off in this repo because the generated client does not compile under it.
- **The generated client never throws.** Calls resolve to `{ data, error, response }`; `lib/api.ts` turns them into Results.
- **macOS treats `claude.md` as `CLAUDE.md`.** That is why the harness notes are named `*.agent.md`. Don't name a file `claude.md` anywhere.
- **Device login needs two browser calls.** The approval page must first claim the code as the signed-in user (`GET …/device?user_code=`), then approve it. The CLI's two-step form (`login --no-wait --json`, then `login --wait`) exists because agent tool calls time out long before a five-minute poll.
- **Tool UIs can hide output.** A harness's command card has shown empty output while the raw tool response held the full JSON. Check the raw result before "fixing" output that is already correct.
- **After a rejected or interrupted command, check what it already did.** Merges and pushes have gone through even when the command was reported as rejected.
- **A fresh package version may be refused locally.** Some setups enforce a minimum release age. Don't loosen a global setting to get around it; exempt only the one package, and only when asked.

## Research behind the design

- **Reference CLIs** (Vercel, Wrangler, gh, Stripe, Resend, Basecamp, Railway, Clerk, Supabase, Sentry): device-code login is the only flow that works over SSH, in containers and in agent sandboxes, so there is no loopback redirect. Stripe-style two-step login keeps agents from blocking. The flag → env → stored-token order comes from gh and Vercel. The stdout/stderr split and auto-JSON when piped come from Resend and Supabase. Basecamp's envelope and Vercel's `next[]` shaped ours. `commands --json`, `doctor` and the skill served by the CLI itself come from the same survey. Agent detection is used for defaults at most; flags and TTYs decide behavior.
- **One contract, every surface:** Zod schemas in the API produce `openapi.json`, from which the client is generated. The direction for later is per-route metadata (read-only, destructive, consent) plus a parity test, so MCP tools and CLI skeletons can be generated from it. Consent flows, login and onboarding stay hand-written.

## Pull requests

Discuss larger changes with the maintainers first. Keep PRs focused, describe what changed and how it was verified, and never include secrets, tokens, personal data or real conversation history in code, tests, fixtures or PR text.
