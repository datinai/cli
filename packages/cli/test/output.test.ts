import { describe, expect, test } from "bun:test";
import { forTerminal, Output, toJson } from "../src/lib/output.ts";

const sink = () => {
  let text = "";
  const write = (chunk: string) => {
    text += chunk;
  };
  return { write, text: () => text };
};

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const RLO = String.fromCodePoint(0x202e);
const TAG = String.fromCodePoint(0xe0041);

describe("terminal output", () => {
  test("another person's control codes are shown, not obeyed", () => {
    const about = `I like trains.${ESC}[2J${ESC}[H(forged line)${ESC}]0;title${BEL} ${RLO}evil${TAG}`;
    const shown = forTerminal(about);
    for (const code of [ESC, BEL, RLO, TAG]) expect(shown).not.toContain(code);
    expect(shown).toContain("I like trains.");
    expect(forTerminal("line one\n\tline two · 👩‍💻 שלום")).toBe("line one\n\tline two · 👩‍💻 שלום");
  });

  test("human mode filters every line it writes; JSON mode stays exact", () => {
    const stdout = sink();
    new Output("human", stdout, sink()).success({ data: {}, summary: `Eve${ESC}[8m` });
    expect(stdout.text()).toBe("Eve�[8m\n");
    const json = sink();
    new Output("json", json, sink()).success({ data: { name: `Eve${ESC}[8m` } });
    expect(JSON.parse(json.text()).data.name).toBe(`Eve${ESC}[8m`);
  });
});

describe("JSON output", () => {
  test("DEL, C1, direction overrides and tag characters are escaped, and parse back exactly", () => {
    const value = { about: `a${String.fromCodePoint(0x7f)}b${String.fromCodePoint(0x9b)}c${RLO}d${TAG}e${ESC}` };
    const text = toJson(value);
    for (const code of [0x7f, 0x9b, 0x202e, 0xe0041, 0x1b]) expect(text).not.toContain(String.fromCodePoint(code));
    expect(JSON.parse(text)).toEqual(value);
  });
});
