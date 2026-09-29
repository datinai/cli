import { describe, expect, test } from "bun:test";
import { exitCodes } from "../src/lib/errors.ts";
import { datin, json } from "./helpers.ts";

const TERMS = { version: 2, urls: { terms: "https://datinapp.com/terms", privacy: "https://datinapp.com/privacy" } };
const logged = { env: { DATIN_TOKEN: "tok" } };

/** A fake API with the terms routes and the account's recorded consents; records what it was sent. */
function api(accepted: number[] = []) {
  const seen: { method: string; path: string; body: unknown; agent: string | null }[] = [];
  return {
    seen,
    respond: async (request: Request) => {
      const path = new URL(request.url).pathname;
      const text = await request.text();
      seen.push({
        method: request.method,
        path,
        body: text ? JSON.parse(text) : undefined,
        agent: request.headers.get("user-agent"),
      });
      if (path === "/v1/terms") return json({ ok: true, data: TERMS });
      if (path === "/v1/onboarding")
        return json({
          ok: true,
          data: {
            profile: { exists: false, version: 0, status: null },
            contacts: { kinds: [] },
            consents: accepted.map((version) => ({ action: "terms", text_version: version })),
          },
        });
      if (path === "/v1/terms/accept") return json({ ok: true, data: { accepted: true, version: 2 } });
      return json({}, 404);
    },
  };
}

describe("terms", () => {
  test("show gives the links and version, and says an older yes doesn't count", async () => {
    const server = api([1]);
    const shown = await datin(["terms", "show"], server.respond, logged);
    expect(shown.exitCode).toBe(0);
    const out = JSON.parse(shown.stdout);
    expect(out.data).toEqual({ ...TERMS, accepted: false });
    expect(out.next[0].command).toBe("datin terms accept 2 --yes");
  });

  test("show works logged out, without guessing whether the account accepted", async () => {
    const shown = JSON.parse((await datin(["terms", "show"], api().respond)).stdout);
    expect(shown.data).toEqual(TERMS);
  });

  test("accept needs the user's yes, then sends the version they were shown", async () => {
    const server = api();
    const refused = await datin(["terms", "accept", "2"], server.respond, logged);
    expect(refused.exitCode).toBe(exitCodes.confirmation_required);
    expect(JSON.parse(refused.stderr).next[0].command).toBe("datin terms accept 2 --yes");
    expect(server.seen).toEqual([]);

    const accepted = await datin(["terms", "accept", "2", "--yes"], server.respond, logged);
    expect(JSON.parse(accepted.stdout).data).toEqual({ accepted: true, version: 2 });
    expect(server.seen.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: "/v1/terms/accept", body: { version: 2 } },
    ]);
    expect((await datin(["terms", "accept", "two", "--yes"], server.respond, logged)).exitCode).toBe(
      exitCodes.usage_error,
    );
  });

  test("`--version` is the program's own flag, so it prints the CLI version and accepts nothing", async () => {
    const server = api();
    const result = await datin(["terms", "accept", "--version", "2", "--yes"], server.respond, logged);
    expect(result.stdout.trim()).toBe("0.0.0-test");
    expect(server.seen).toEqual([]);
  });

  test("requests identify the CLI as datin/<version>, which the API's version gate reads", async () => {
    const server = api();
    await datin(["terms", "show"], server.respond, logged);
    expect(server.seen[0]?.agent).toBe("datin/0.0.0-test");
  });
});

describe("refusals from a newer API", () => {
  const refuse = (status: number, error: Record<string, unknown>) => () =>
    json({ ok: false, error: { retryable: false, ...error } }, status);

  test("update_required has its own exit code and always says how to update", async () => {
    const result = await datin(
      ["recs", "list"],
      refuse(426, {
        code: "update_required",
        message: "This datin is too old",
        details: { minimum: "0.1.1", yours: "0.1.0" },
      }),
      logged,
    );
    expect(result.exitCode).toBe(exitCodes.update_required);
    const error = JSON.parse(result.stderr).error;
    expect(error.hint).toContain("bunx datin@latest");
    expect(error.details).toEqual({ minimum: "0.1.1", yours: "0.1.0" });
  });

  test("a code this CLI has never heard of still shows the server's words", async () => {
    const result = await datin(
      ["recs", "list"],
      refuse(418, { code: "brand_new_code", message: "Something new happened", hint: "Do the new thing" }),
      logged,
    );
    expect(result.exitCode).toBe(exitCodes.internal_error);
    const error = JSON.parse(result.stderr).error;
    expect(error).toMatchObject({
      code: "internal_error",
      message: "Something new happened",
      hint: "Do the new thing",
      details: { server_code: "brand_new_code" },
    });
  });

  test("a daily quota is reported at once, even when it resets in seconds, and the terminal names it", async () => {
    let calls = 0;
    const quota = () => {
      calls++;
      return json(
        {
          ok: false,
          error: {
            code: "rate_limited",
            message: "That is 30 likes today",
            retryable: true,
            details: { limited_by: "likes", retry_after_seconds: 5 },
          },
        },
        429,
      );
    };
    const piped = await datin(["recs", "like", "p1"], quota, logged);
    expect(piped.exitCode).toBe(exitCodes.rate_limited);
    expect(calls).toBe(1);

    const human = await datin(["recs", "like", "p1"], quota, { ...logged, stdoutIsTTY: true });
    expect(human.stderr).toContain("limit: daily likes, try again in 5 s");
  });
});
