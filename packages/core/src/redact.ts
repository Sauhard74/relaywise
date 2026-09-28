const MIN_SECRET_LENGTH = 8;

/** Returns a function that replaces every occurrence of the given secret values with `[REDACTED]`. */
export function makeRedactor(secrets: Iterable<string>): (text: string) => string {
  const expanded = [...secrets].flatMap((s) => [s, ...jsonLeaves(s)]);
  const values = [...new Set(expanded.filter((s) => s && s.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  if (values.length === 0) return (text) => text;
  const pattern = new RegExp(values.map(escapeRegExp).join("|"), "g");
  return (text) => text.replace(pattern, "[REDACTED]");
}

/** String values inside a JSON secret (tokens in an auth file), long enough to be credentials. */
function jsonLeaves(secret: string): string[] {
  if (!secret.trimStart().startsWith("{")) return [];
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string" && v.length >= 20) out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(secret));
  } catch {
    /* not JSON */
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
