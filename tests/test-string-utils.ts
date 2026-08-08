/**
 * Comprehensive unit tests for src/string-utils.ts
 * Covers: countVowels, isPalindrome, reverseString, capitalizeWords
 */
import { strict as assert } from "node:assert";
import {
	countVowels,
	isPalindrome,
	reverseString,
	capitalizeWords,
} from "../src/string-utils";

let passed = 0;
let failed = 0;

function check(description: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${description}`);
	} catch (error: any) {
		failed++;
		console.log(`  ✗ ${description}: ${error.message}`);
	}
}

// ─── countVowels ──────────────────────────────────────────────────────

console.log("\n--- countVowels ---");

check("returns 0 for empty string", () => {
	assert.strictEqual(countVowels(""), 0);
});

check("returns 0 for string with no vowels", () => {
	assert.strictEqual(countVowels("xyz"), 0);
	assert.strictEqual(countVowels("123"), 0);
	assert.strictEqual(countVowels("!@#"), 0);
});

check("counts all five vowels (lowercase)", () => {
	assert.strictEqual(countVowels("aeiou"), 5);
});

check("counts all five vowels (uppercase)", () => {
	assert.strictEqual(countVowels("AEIOU"), 5);
});

check("counts mixed-case vowels", () => {
	assert.strictEqual(countVowels("Hello World"), 3); // e, o, o
	assert.strictEqual(countVowels("Quick brown fox"), 4); // u, i, o, o
});

check("ignores non-ASCII vowel-like characters", () => {
	// é, ü, ā are NOT ASCII vowels
	assert.strictEqual(countVowels("café"), 1); // only 'a'
	assert.strictEqual(countVowels("über"), 1); // only 'u'
});

check("counts repeated vowels", () => {
	assert.strictEqual(countVowels("aaa"), 3);
	assert.strictEqual(countVowels("AAA"), 3);
});

check("counts vowels in long string", () => {
	assert.strictEqual(countVowels("The quick brown fox jumps over the lazy dog"), 11);
});

check("handles string with only vowels", () => {
	assert.strictEqual(countVowels("aeiouAEIOU"), 10);
});

check("throws TypeError for non-string input", () => {
	assert.throws(() => countVowels(undefined), TypeError);
	assert.throws(() => countVowels(null as unknown as string), TypeError);
	assert.throws(() => countVowels(42 as unknown as string), TypeError);
	assert.throws(() => countVowels({} as unknown as string), TypeError);
});

check("handles unicode strings without counting non-ASCII vowels", () => {
	assert.strictEqual(countVowels("你好世界"), 0);
	assert.strictEqual(countVowels("Привет"), 1); // 'e' is the only ASCII vowel
});

// ─── isPalindrome ─────────────────────────────────────────────────────

console.log("\n--- isPalindrome ---");

check("returns true for empty string", () => {
	assert.strictEqual(isPalindrome(""), true);
});

check("returns true for single character", () => {
	assert.strictEqual(isPalindrome("a"), true);
	assert.strictEqual(isPalindrome("Z"), true);
});

check("recognizes simple palindromes", () => {
	assert.strictEqual(isPalindrome("racecar"), true);
	assert.strictEqual(isPalindrome("madam"), true);
});

check("is case-insensitive after normalization", () => {
	assert.strictEqual(isPalindrome("Racecar"), true);
	assert.strictEqual(isPalindrome("Madam"), true);
});

check("ignores non-alphanumeric characters", () => {
	assert.strictEqual(isPalindrome("A man, a plan, a canal: Panama"), true);
	assert.strictEqual(isPalindrome("Was it a car or a cat I saw?"), true);
	assert.strictEqual(isPalindrome("No 'x' in Nixon"), true);
});

check("handles numeric palindromes", () => {
	assert.strictEqual(isPalindrome("12321"), true);
	assert.strictEqual(isPalindrome("12345"), false);
});

check("rejects non-palindromes", () => {
	assert.strictEqual(isPalindrome("hello"), false);
	assert.strictEqual(isPalindrome("world"), false);
});

check("strips all non-alphanumeric characters including non-ASCII", () => {
	assert.strictEqual(isPalindrome("A Toyota's a Toyota"), true);
	assert.strictEqual(isPalindrome("А роза упала на лапу Азора"), false); // non-ASCII stripped
});

check("handles string with only non-alphanumeric characters", () => {
	assert.strictEqual(isPalindrome("!@# $%^"), true); // all stripped -> empty
});

check("throws TypeError for non-string input", () => {
	assert.throws(() => isPalindrome(undefined), TypeError);
	assert.throws(() => isPalindrome(null as unknown as string), TypeError);
	assert.throws(() => isPalindrome(12321 as unknown as string), TypeError);
});

check("handles palindrome with mixed case and punctuation", () => {
	assert.strictEqual(isPalindrome("Never odd or even"), true);
	assert.strictEqual(isPalindrome("Doc, note: I dissent. A fast never prevents a fatness. I diet on cod."), true);
});

// ─── reverseString ────────────────────────────────────────────────────

console.log("\n--- reverseString ---");

check("returns empty string for empty input", () => {
	assert.strictEqual(reverseString(""), "");
});

check("reverses a single character", () => {
	assert.strictEqual(reverseString("a"), "a");
});

check("reverses a simple string", () => {
	assert.strictEqual(reverseString("hello"), "olleh");
	assert.strictEqual(reverseString("world"), "dlrow");
});

check("reverses a palindrome", () => {
	assert.strictEqual(reverseString("racecar"), "racecar");
});

check("reverses a string with spaces", () => {
	assert.strictEqual(reverseString("hello world"), "dlrow olleh");
});

check("reverses a string with special characters", () => {
	assert.strictEqual(reverseString("!@# $%^"), "^%$ #@!");
});

check("reverses a string with unicode characters", () => {
	assert.strictEqual(reverseString("你好世界"), "界世好你");
});

check("reverses a string with emoji", () => {
	assert.strictEqual(reverseString("abc😀def"), "fed😀cba");
});

check("throws TypeError for non-string input", () => {
	assert.throws(() => reverseString(undefined), TypeError);
	assert.throws(() => reverseString(null as unknown as string), TypeError);
	assert.throws(() => reverseString(true as unknown as string), TypeError);
});

check("reverse of reverse is original", () => {
	const original = "The quick brown fox";
	assert.strictEqual(reverseString(reverseString(original)), original);
});

// ─── capitalizeWords ──────────────────────────────────────────────────

console.log("\n--- capitalizeWords ---");

check("returns empty string for empty input", () => {
	assert.strictEqual(capitalizeWords(""), "");
});

check("capitalizes a single word", () => {
	assert.strictEqual(capitalizeWords("hello"), "Hello");
});

check("capitalizes multiple words", () => {
	assert.strictEqual(capitalizeWords("hello world"), "Hello World");
});

check("lowercases remaining characters in each word", () => {
	assert.strictEqual(capitalizeWords("HELLO WORLD"), "Hello World");
	assert.strictEqual(capitalizeWords("hELLo wORLD"), "Hello World");
});

check("preserves multiple spaces between words", () => {
	assert.strictEqual(capitalizeWords("hello   world"), "Hello   World");
});

check("preserves leading and trailing whitespace", () => {
	assert.strictEqual(capitalizeWords("  hello world  "), "  Hello World  ");
});

check("preserves tabs and newlines", () => {
	assert.strictEqual(capitalizeWords("hello\tworld\nfoo"), "Hello\tWorld\nFoo");
});

check("handles single character words", () => {
	assert.strictEqual(capitalizeWords("a b c"), "A B C");
});

check("handles empty words from consecutive spaces", () => {
	const result = capitalizeWords("hello  world");
	assert.strictEqual(result, "Hello  World");
});

check("throws TypeError for non-string input", () => {
	assert.throws(() => capitalizeWords(undefined), TypeError);
	assert.throws(() => capitalizeWords(null as unknown as string), TypeError);
	assert.throws(() => capitalizeWords([] as unknown as string), TypeError);
});

check("handles string with numbers and special characters", () => {
	assert.strictEqual(capitalizeWords("hello123 world!"), "Hello123 World!");
});

check("handles unicode words", () => {
	// Unicode characters that don't have case mapping remain unchanged
	const result = capitalizeWords("你好 世界");
	assert.strictEqual(result, "你好 世界");
});

check("preserves mixed whitespace sequences", () => {
	assert.strictEqual(capitalizeWords("hello\n\n\nworld"), "Hello\n\n\nWorld");
});

check("strips internal whitespace-only tokens correctly", () => {
	assert.strictEqual(capitalizeWords(""), "");
});

// ─── Report ───────────────────────────────────────────────────────────

console.log(`\n=== String Utils: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
