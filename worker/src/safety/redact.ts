const PATTERNS: [string, RegExp][] = [
  ["openai/anthropic-style key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["stripe-style key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["credential assignment", /\b[A-Za-z_]*(?:secret|token|passw(?:or)?d|api[_-]?key|apikey)[A-Za-z_]*\s*[=:]\s*\S{6,}/i],
  ["absolute home path", /(?:^|[\s"'(=])(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s/\\]+/],
];

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** A long mixed-case-and-digit run with high entropy looks like a key. Lowercase hex (SHAs, UUIDs) passes. */
function looksRandom(token: string): boolean {
  return token.length >= 24 && /[A-Z]/.test(token) && /[a-z]/.test(token) && /\d/.test(token) && entropy(token) >= 4.3;
}

/** Returns the reason text looks like a secret, or null. Callers reject the write; nothing is silently scrubbed. */
export function findSecret(text: string): string | null {
  for (const [name, re] of PATTERNS) if (re.test(text)) return name;
  for (const token of text.split(/[\s/\\.,:;'"()[\]{}<>=|`]+/)) if (looksRandom(token)) return "high-entropy token";
  return null;
}
