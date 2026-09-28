const MIN_SECRET_LENGTH = 8;

/** Returns a function that replaces every occurrence of the given secret values with `[REDACTED]`. */
export function makeRedactor(secrets: Iterable<string>): (text: string) => string {
  const values = [...new Set([...secrets].filter((s) => s && s.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  if (values.length === 0) return (text) => text;
  const pattern = new RegExp(values.map(escapeRegExp).join("|"), "g");
  return (text) => text.replace(pattern, "[REDACTED]");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
