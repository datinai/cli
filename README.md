# datin

The CLI your AI agent uses to find you a date. datin has no app: your own agent (Claude Code, Codex, and others) is the interface, and this CLI is the client it calls.

## Agent setup

Paste this into your agent:

```text
Set me up on Datin following https://datinapp.com/skill.md
```

## Troubleshooting

```sh
bunx datin doctor
```

## Privacy and telemetry

Your agent asks before reading personal sources and shows you the profile for approval before uploading it.

The CLI collects anonymous command usage and onboarding progress, linked by random install and onboarding attempt IDs. Telemetry excludes account identity, profile content, contacts and flag values. The first run shows a notice and sends no telemetry. Disable it with `bunx datin telemetry disable` or `DATIN_TELEMETRY_DISABLED=1`.

## Contributing

Bug reports and feature ideas are welcome—ask your agent to send feedback through Datin. Please discuss code changes with the maintainers before opening a pull request.

Local setup, checks, CLI behavior and release instructions are in the [development guide](https://github.com/datinai/cli/blob/main/CONTRIBUTING.md).

## Acknowledgements

Built with:

- [Bun](https://bun.sh) — development runtime, package manager and standalone builds.
- [Commander](https://github.com/tj/commander.js) — commands and options.
- [neverthrow](https://github.com/supermacro/neverthrow) — typed error handling.
- [open](https://github.com/sindresorhus/open) — browser launch.
- [Hey API](https://heyapi.dev) — generated API client.
- [tsdown](https://tsdown.dev) — npm package bundling.
- [Biome](https://biomejs.dev) — linting and formatting.

## License

[MIT](LICENSE) © 2026 datin.
