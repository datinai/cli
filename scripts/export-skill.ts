import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: bun run skill:export <website-public-directory>");

const source = new URL("../skills/datin/", import.meta.url);
const markdown = await Bun.file(new URL("SKILL.md", source)).text();
const frontmatter = markdown.split("---\n")[1];
const name = frontmatter?.match(/^name: (.+)$/m)?.[1];
const description = frontmatter?.match(/^description: (.+)$/m)?.[1];
if (name !== "datin" || !description) throw new Error("Expected Datin skill frontmatter with a description");

const files = [
  "SKILL.md",
  ...(await readdir(new URL("agents/", source)))
    .filter((file) => file.endsWith(".agent.md"))
    .sort()
    .map((file) => `agents/${file}`),
];
const output = resolve(destination, ".well-known/agent-skills");
for (const file of files) {
  await Bun.write(resolve(output, name, file), Bun.file(new URL(file, source)));
}
// The directory index lets skills installers fetch the references as well as SKILL.md.
await Bun.write(`${output}/index.json`, `${JSON.stringify({ skills: [{ name, description, files }] }, null, 2)}\n`);
console.log(`Exported ${files.length} skill files and discovery index to ${output}`);
