/** `NAME=value` (or `Name: value`) per line into a record; null when a line has no name or separator. */
export function parseConnectorPairs(
  text: string,
  separator: "=" | ":",
): Record<string, string> | null {
  const pairs: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const at = line.indexOf(separator);
    const name = at < 0 ? "" : line.slice(0, at).trim();
    if (name === "") return null;
    pairs[name] = line.slice(at + 1).trim();
  }
  return pairs;
}
