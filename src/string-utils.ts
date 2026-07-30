/**
 * ═══════════════════════════════════════════════════════════════
 * String Utility Functions
 * ═══════════════════════════════════════════════════════════════
 *
 * Design Spec: workflow-output/design/spec.md
 * Language:    TypeScript (strict mode)
 * Runtime:     Node.js ≥ 20 LTS
 * Module:      ES module
 *
 * All functions operate at the Unicode code-point level using
 * `[...s]` for iteration.  They reject non-string inputs with a
 * `TypeError`.
 */

// ─── Type guard ───────────────────────────────────────────────

function assertIsString(input: unknown): asserts input is string {
  if (typeof input !== "string") {
    throw new TypeError("Input must be a string");
  }
}

// ─── 2.1 countVowels ──────────────────────────────────────────

const VOWEL_SET = new Set([
  "a", "e", "i", "o", "u",
  "A", "E", "I", "O", "U",
]);

/**
 * Count the number of ASCII vowel characters (`a`, `e`, `i`, `o`, `u` —
 * case-insensitive) in the input string.
 *
 * - Operates at the Unicode code-point level (`[...input]`).
 * - Only ASCII Latin-script vowels are recognised (diacritics such as
 *   `é`, `ü`, `ā` do NOT count).
 *
 * @throws {TypeError} If `input` is not a string.
 */
export function countVowels(input: unknown): number {
  assertIsString(input);

  let count = 0;
  for (const ch of input) {
    if (VOWEL_SET.has(ch)) {
      count++;
    }
  }
  return count;
}

// ─── 2.2 isPalindrome ─────────────────────────────────────────

/**
 * Determine whether `input` reads the same forwards and backwards
 * after normalisation:
 *   1. Case-folding via `String.prototype.toLowerCase()`.
 *   2. Stripping every character NOT matching `/[a-z0-9]/`.
 *
 * - Operates at the Unicode code-point level.
 * - Normalisation is ASCII-alphanumeric only — CJK, accented Latin,
 *   Cyrillic, etc. are all stripped.
 *
 * @throws {TypeError} If `input` is not a string.
 */
export function isPalindrome(input: unknown): boolean {
  assertIsString(input);

  // 1. Case-fold.
  const lowered = input.toLowerCase();

  // 2. Retain only ASCII lowercase letters and digits.
  const filtered: string[] = [];
  for (const ch of lowered) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      filtered.push(ch);
    }
  }

  // 3. Compare against its reverse.
  const forward = filtered.join("");
  const reversed = filtered.slice().reverse().join("");

  return forward === reversed;
}

// ─── 2.3 reverseString ────────────────────────────────────────

/**
 * Return a new string whose Unicode code points are the reverse of
 * those in `input`.
 *
 * Implementation: `[...input].reverse().join("")`.
 *
 * @throws {TypeError} If `input` is not a string.
 */
export function reverseString(input: unknown): string {
  assertIsString(input);

  return [...input].reverse().join("");
}

// ─── 2.4 capitalizeWords ──────────────────────────────────────

/**
 * Return a new string where the first character of each whitespace-
 * delimited word is uppercased and all remaining characters in the
 * word are lowercased.
 *
 * - Whitespace characters are preserved verbatim (including tabs,
 *   newlines, multiple spaces, etc.).
 * - Words are split on `/(\s+)/` (capturing group so delimiters are
 *   retained).
 *
 * @throws {TypeError} If `input` is not a string.
 */
export function capitalizeWords(input: unknown): string {
  assertIsString(input);

  // split with capturing group preserves the whitespace tokens
  const tokens = input.split(/(\s+)/);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Whitespace tokens are left untouched
    if (token === "" || /^\s+$/.test(token)) {
      continue;
    }

    // Non-whitespace token → capitalise
    const chars = [...token];

    if (chars.length > 0) {
      const first = chars[0]!.toUpperCase();
      const rest = chars
        .slice(1)
        .map((c) => c.toLowerCase())
        .join("");
      tokens[i] = first + rest;
    }
  }

  return tokens.join("");
}
