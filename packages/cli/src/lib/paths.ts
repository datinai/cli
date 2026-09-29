import { homedir } from "node:os";
import { join } from "node:path";

/** `$XDG_CONFIG_HOME/datin`, or `~/.config/datin`. Holds the login token, a pending login and `telemetry.json`. */
export function configDir(env: Readonly<Record<string, string | undefined>>): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "datin");
}
