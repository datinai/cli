import { type Command, InvalidArgumentError } from "@commander-js/extra-typings";
import { acceptTerms, getOnboardingFacts, getTerms } from "@datin/api-client";
import { describe, type Finish } from "../define-command.ts";
import { apiErrors, authedErrors, localError } from "../lib/errors.ts";
import { fromLocal } from "../lib/local.ts";
import { errAsync, okAsync } from "../lib/result.ts";

/** The consent action the API records the terms yes under (see GET /v1/onboarding). */
const TERMS_ACTION = "terms";

export function registerTerms(program: Command, finish: Finish): void {
  const terms = program
    .command("terms")
    .description("datin's terms and privacy policy: where to read them, and the user's yes to them");

  describe(
    terms
      .command("show")
      .description("The current terms version and links, and whether this account accepted it")
      .action(() =>
        finish((context) =>
          context.api
            .call((client) => getTerms({ client }))
            .andThen(({ data }) =>
              fromLocal(context.token(), "read the stored login").andThen((resolved) => {
                // Logged out, the links and version still stand; only whether this account said yes is unknown.
                if (!resolved.token) return okAsync({ data: { ...data, accepted: undefined } });
                return context
                  .authed()
                  .andThen((api) => api.call((client) => getOnboardingFacts({ client })))
                  .map(({ data: facts }) => ({
                    data: {
                      ...data,
                      accepted: facts.consents.some(
                        (c) => c.action === TERMS_ACTION && c.text_version === data.version,
                      ),
                    },
                  }));
              }),
            )
            .map(({ data }) => ({
              data,
              summary:
                data.accepted === true
                  ? `The current terms (version ${data.version}) are accepted`
                  : `Show the user ${data.urls.terms} and ${data.urls.privacy}; only after their yes, accept version ${data.version}`,
              ...(data.accepted !== true && {
                next: [
                  {
                    command: `datin terms accept ${data.version} --yes`,
                    when: "only after the user read the links and said yes",
                  },
                ],
              }),
            })),
        ),
      ),
    {
      examples: ["datin terms show --json"],
      errors: [...apiErrors, "auth_required", "local_state_error"],
    },
  );

  describe(
    terms
      .command("accept")
      .description("Record the user's yes to the terms and privacy policy, at the version they were shown")
      // A positional argument, not `--version`: that flag belongs to the program and prints the CLI's version.
      .argument("<version>", "the version from `datin terms show`", (value) => {
        const version = Number(value);
        if (!Number.isInteger(version) || version < 1)
          throw new InvalidArgumentError("It has to be a whole number, 1 or more");
        return version;
      })
      .option("--yes", "the user read the terms and privacy policy and agreed")
      .action((version, options) =>
        finish((context) =>
          options.yes
            ? context.authed().andThen((api) => api.call((client) => acceptTerms({ client, body: { version } })))
            : errAsync(
                localError("confirmation_required", "Accepting the terms needs the user's yes", {
                  hint: "Show the user both links from `datin terms show`, and run the command below only after they agree",
                  next: [{ command: `datin terms accept ${version} --yes`, when: "only after the user said yes" }],
                }),
              ),
        ),
      ),
    {
      examples: ["datin terms accept 1 --yes"],
      errors: [...authedErrors, "validation_failed", "confirmation_required"],
    },
  );
}
