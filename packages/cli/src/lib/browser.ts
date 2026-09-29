import open from "open";

/** Launch the approval URL without waiting for the browser to close. */
export async function openBrowser(url: string): Promise<void> {
  if (!["https:", "http:"].includes(new URL(url).protocol)) throw new Error("Expected an HTTP(S) approval URL");
  await open(url);
}
