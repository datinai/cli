# Contributing to Datin

Please discuss changes with the maintainers before opening a pull request. Keep changes focused, preserve existing behavior, and run `bun run check` before submitting.

## Built for agents first

- **JSON when piped.** stdout carries exactly one JSON document, `{ ok, data, summary?, next? }`. Progress and next steps go to stderr. In a terminal, one formatter prints the result without repeating its summary; `--json` forces JSON.
- **Browser login.** Plain `datin login` opens the approval page when stdin and stdout are terminals. It always prints the URL and code. `--no-browser`, `--json`, piped output, `--no-wait` and `--wait` never open the browser. If opening fails, use the printed link; login continues waiting.
- **Typed failures.** Errors are `{ ok: false, error: { code, message, hint?, retryable } }` on stderr, and each `code` has its own exit status:

  | exit | codes |
  |---|---|
  | 1 | `internal_error` |
  | 2 | `usage_error` |
  | 3 | `auth_required`, `login_pending`, `login_expired`, `account_disabled` |
  | 4 | `not_found` |
  | 5 | `profile_conflict` |
  | 6 | `validation_failed` |
  | 7 | `network_error` |
  | 8 | `rate_limited` |
  | 9 | `confirmation_required` |
  | 10 | `consent_required` |
  | 11 | `source_disabled` |
  | 12 | `reconnect_required` |
  | 13 | `local_state_error` |

- **Two carve-outs.** `--help`, and `datin` with nothing after it, print plain help text on stdout and exit 0.
- **Asks before it looks.** Reading a local data source (`sources detect`, `sources prompt`) is refused with `consent_required` until `datin sources consent <id> --granted` recorded the user's yes; the refusal carries the what, why and where-it-goes text to say to them.
- **Never prompts.** Missing input fails with the exact flags to pass.
- **Logout clears local Datin data.** `datin logout` revokes the current token and clears the local profile, evidence, source consents, onboarding state and pending sign-in. It returns `confirmation_required` before acting if there is unfinished local work; `datin logout --yes` discards it. Evidence and unpushed drafts cannot be restored by login. A fully synced profile with completed sources logs out directly. The saved server profile/account, telemetry preferences, unrelated files and credentials for other API origins remain. External scheduler jobs are not removed by clearing their local onboarding marker.
- **Login in a private file.** The token lives in `$XDG_CONFIG_HOME/datin/credentials.json` (default `~/.config/datin/`), directory `0700`, file `0600`, one token per API origin: the same approach as Wrangler, Codex and Convex. No OS keychain, so no system prompt. `--token` and `DATIN_TOKEN` take precedence and never read the file.
- **Describes itself.** `datin commands --json` lists commands, examples, expected errors and `global_options`. Options include defaults and choices, whether the option itself is `required`, and whether its value is `value_required` or `value_optional`. Every command documents parser and unexpected failures alongside its handler's expected errors.
- **Keeps your API selection.** Datin's `next` commands inherit a non-default API URL and explicit `--json`, unless the hint already specifies them. Tokens are never copied into hints. External commands are left as supplied.
- **Knows each harness.** `datin agent instructions <claude|codex|openclaw|hermes|muse|pi|opencode|grok>` tells an agent which of its own tools to use for asking, scheduling, history and showing people. The text lives in `skills/datin/agents/` and is embedded at build time, so it works offline.
- **Waits out short limits.** When the API asks for a pause of a few seconds it retries once by itself; longer waits are reported as `rate_limited` with `retry_after_seconds`.
- **Listens.** `datin feedback create --message …` sends what the user said to the team and returns a receipt. Confirmation email is disabled until domain onboarding is complete.

## Repository

```
openapi.json            snapshot of the API's OpenAPI spec (the contract)
packages/api-client     client generated from it; never edited by hand
packages/cli            the CLI (Commander, neverthrow, bundled with tsdown)
skills/datin            the skill that teaches an agent to use datin; agents/*.agent.md are the per-harness notes
```

```sh
bun install
bun run datin -- doctor --api-url http://localhost:8787
bun run datin -- login --no-wait --json
bun run check           # lint, generated-client freshness, types, tests
bun run spec:pull       # refresh openapi.json from the live API, then `bun run generate`
bun run agents:embed    # after editing skills/datin/agents/*.agent.md (also part of `bun run generate`)
bun run build:binary    # standalone executable for the current OS and architecture
```

`bun run datin -- …` runs the TypeScript source directly with Bun, forwarding arguments and the exit code without a build step. Packaging builds the distributable; the existing binary smoke tests check Node compatibility. `login --timeout` accepts whole seconds (including `0` for a single poll) for both plain login and `login --wait`.

PR updates and pushes to `main` run lint, generation checks, types and tests, followed by one Linux x64 standalone smoke check. They do not upload binary artifacts or publish packages. New commits cancel superseded CI runs. Use the manual `release` workflow on a branch when a change needs all six platforms and the packed npm distribution checked before tagging; manual runs do not publish.

### npm releases

The unscoped public package is `datin`; its executable is also `datin`. Update `packages/cli/package.json` to the intended version, merge the change to `main`, then push its matching tag (for example `v0.0.1`). The `release.yml` workflow requires that the tag matches the package version and points to a commit on `main`. It runs regular CI, builds all six standalone targets, and uses `bun pm pack` to build the npm tarball. It installs that tarball outside the checkout and verifies the version, command catalogue and embedded harness notes before publishing those exact bytes to npm as `latest`. The workflow accepts an already-published version only if its SHA-512 integrity matches the verified tarball. It then creates a GitHub release containing the standalone archives.

Publishing uses npm's GitHub Actions trusted publisher (OIDC), with `id-token: write` and the GitHub environment `npm`. Dependency installation, builds and packing use Bun; only the publish operation uses npm for OIDC support. No npm token is stored in GitHub. Configure the npm package's trusted publisher with organization `datinai`, repository `cli`, workflow `release.yml`, environment `npm`, and direct publishing allowed. Keep account 2FA enabled. Provenance is disabled because npm cannot attest builds from this private repository.

The first-publish bootstrap is complete, and GitHub OIDC publishing was verified with `0.0.2`. Publish subsequent releases through the tag workflow, not from a local session. The npm organization is `datin`; the GitHub organization in the trusted-publisher configuration is `datinai`. Never overwrite a published version or move a release tag.

Biome uses its recommended lint rules, with warnings treated as failures. Unused imports and variables, explicit `any`, and focused tests are errors. CLI source also disallows `console` calls so command output goes through the renderer; scripts and tests can use the console. Generated API code and build output remain excluded.

The root README is the authored copy. From `packages/cli`, `bun pm pack` runs `prepack` to build fresh output and copy this README into the package; the copied file is ignored by Git. Before a release, install that tarball in a clean directory and smoke-test the installed `datin` command. Packing does not publish it.

`bun run build:binary` writes `dist/artifacts/<platform>-<arch>/datin` (`datin.exe` on Windows). Use `--target linux-x64`, for example, or `--target all` to cross-compile all six targets. Standalone executables ignore the working directory's `.env` and `bunfig.toml`, just like the Node distribution. On Linux, browser login uses the system's `xdg-open`.

The error codes come from the API's spec as one generated union type. `packages/cli/src/lib/errors.ts` maps each to an exit code with `satisfies`, so a new server error code fails the build here until it is handled.

`DATIN_API_URL` or `--api-url` points the CLI at another API, for example a local one.

### Type safety in code review

These review guidelines borrow selectively from [anti-slop](https://github.com/dmmulroy/anti-slop):

- Preserve inferred types and literal keys. Use `satisfies` to check a contract without widening the value, and derive shared types from the generated API or owning library.
- Fix type mismatches at their source. Avoid chained assertions such as `as unknown as T` and widening a known value only to cast it back later. For an unavoidable assertion, explain the concrete invariant beside it; a comment does not replace validation.
- Accept `unknown` at external boundaries and validate it before passing domain values inward. Runtime `typeof` checks are appropriate here; do not add wrappers just to avoid them.
- Avoid copying a growing accumulator on every iteration. Biome already checks accumulating spreads; review other repeated copies for the same problem.

Biome's local `scripts/lint/no-chained-type-assertions.grit` rule rejects chained `as` and angle-bracket assertions, including chains separated by parentheses. Single assertions and chains consisting only of `as const` / `<const>` remain allowed. It reports an error without an automatic fix. The remaining type-safety guidance is enforced through review; Biome remains the only linter. Choose conditional spreads and array pipelines for clarity and actual workload, without blanket bans or mandatory assertion-comment markers.


### Local commit checks

Run `bun run hooks:install` once after cloning. The pre-commit hook runs `bun run lint`; CI runs the same strict Biome check on every PR and main push. Hooks remain local Git configuration, so each checkout needs installation.

### Onboarding completion and analytics

`onboarding status` derives completion from current facts: every enabled source needs a decision for its current consent version and completed/skipped reading; the local profile hash and version must match the server. Scheduling requires `schedule confirm --every 3h --job "<scheduler job id or path>"` after the agent creates or verifies the actual task. This records an attestation, not a scheduler integration; deleted or paused external jobs cannot be detected by the CLI.

When telemetry is enabled, successful onboarding commands report `onboarding_step_completed` through the existing `/v1/t` request. Status also observes steps restored from the server or completed outside the CLI, so repeated events are expected. Events use the same random install ID as command analytics, plus a random onboarding attempt ID that survives CLI restarts and is cleared on logout. No account ID, auth session, scheduler job reference, source contents, contact data, or profile values are sent. Existing opt-outs apply.

These measure observed milestones, not a guarantee that the profile was genuinely reviewed or a scheduled job remains active. Local file edits are observed at `profile diff`, push, or status. First-notice runs, opted-out installs, and failed telemetry deliveries are absent; there is no delivery queue. Account switching on one install requires logout to start a new attempt; devices cannot be linked.
