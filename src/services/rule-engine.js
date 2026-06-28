// src/services/rule-engine.js
// ─────────────────────────────────────────────────────────────────────────────
// RULE-BASED CHAT ENGINE
//
// Pure functions — no DB access, no side effects.
// The route handler fetches data; this module only processes it.
// This makes the logic trivially unit-testable.
//
// Processing pipeline (in strict order):
//   1. tryCaptureName()   — regex, runs first, short-circuits everything else
//   2. matchRules()       — scans tenant's ChatRule rows
//   3. fallback message   — returned by the route if matchRules() returns null
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// NAME CAPTURE
//
// Patterns detected (all case-insensitive):
//   "I am Deepu"          → name: "Deepu"
//   "I'm Raja"            → name: "Raja"
//   "my name is Priya"    → name: "Priya"
//   "call me John"        → name: "John"
//   "this is Sarah"       → name: "Sarah"
//   "it's Alex"           → name: "Alex"
//
// Named capture group `name` extracts 1–40 word characters.
// The \b word boundary prevents matching "I am amazing" as name="amazing".
// ─────────────────────────────────────────────────────────────────────────────
const NAME_PATTERNS = [
  /(?:i\s+am|i'm)\s+(?<name>[A-Za-z][A-Za-z'\-]{0,39})(?:\s|$|[.,!?])/i,
  /my\s+name\s+is\s+(?<name>[A-Za-z][A-Za-z'\-]{0,39})(?:\s|$|[.,!?])/i,
  /call\s+me\s+(?<name>[A-Za-z][A-Za-z'\-]{0,39})(?:\s|$|[.,!?])/i,
  /(?:this\s+is|it's|its)\s+(?<name>[A-Za-z][A-Za-z'\-]{0,39})(?:\s|$|[.,!?])/i,
];

// Words that look like names but are clearly not — prevents "I am fine" → name "fine"
const NAME_STOPWORDS = new Set([
  'fine', 'good', 'okay', 'ok', 'here', 'back', 'ready', 'sorry', 'sure',
  'not', 'just', 'also', 'still', 'already', 'always', 'never', 'done',
  'going', 'trying', 'looking', 'checking', 'asking', 'writing', 'calling',
  'a', 'an', 'the', 'new', 'old', 'well', 'great', 'nice', 'happy', 'right',
]);

/**
 * tryCaptureName
 * Tries every name pattern against the message.
 * @param {string} message — raw user input
 * @returns {string|null} — the captured name (title-cased) or null
 */
export function tryCaptureName(message) {
  for (const pattern of NAME_PATTERNS) {
    const match = message.match(pattern);
    if (match?.groups?.name) {
      const raw = match.groups.name.trim();
      // Reject stop-words and single characters
      if (raw.length < 2 || NAME_STOPWORDS.has(raw.toLowerCase())) continue;
      // Title-case: "john" → "John", "O'Brien" stays as-is
      return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// KEYWORD MATCHING
//
// Rule.exactMatch = false (default — OR logic):
//   keywords = "pricing, cost, how much"
//   Each token is trimmed and tested as a case-insensitive substring.
//   If the message contains ANY single token → rule fires.
//   Order: specific multi-word tokens are tested before short ones
//   (sorted by length DESC) to prevent "cost" shadowing "cost breakdown".
//
// Rule.exactMatch = true (full-phrase mode):
//   The entire `keywords` string is treated as ONE phrase.
//   The message must contain it verbatim (case-insensitive).
//   Use for greetings like "good morning" or precise product codes.
//
// Rules are pre-sorted by the DB query (priority DESC, createdAt ASC).
// First match wins — no scoring, no ambiguity.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * matchRules
 * @param {string}   message  — normalised (trimmed, lowercased) user input
 * @param {Array}    rules    — ChatRule rows from DB, sorted by priority DESC
 * @returns {string|null}     — matched replyText, or null if no rule fired
 */
export function matchRules(message, rules) {
  // Normalise once — avoid repeated .toLowerCase() inside the loop
  const normalised = message.toLowerCase().trim();

  for (const rule of rules) {
    if (!rule.isActive) continue;

    if (rule.exactMatch) {
      // ── Exact / full-phrase match ─────────────────────────────────────
      // The entire keywords string is the phrase to look for.
      // e.g. keywords = "good morning" → match only "good morning", not "morning"
      const phrase = rule.keywords.toLowerCase().trim();
      if (normalised.includes(phrase)) {
        return rule.replyText;
      }
    } else {
      // ── Keyword list match (OR logic) ─────────────────────────────────
      // Parse comma-separated tokens, skip blanks, sort longest-first.
      const tokens = rule.keywords
        .split(',')
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length > 0)
        .sort((a, b) => b.length - a.length);   // longest first → more specific wins

      for (const token of tokens) {
        // Use word-boundary-aware check for short tokens to reduce false positives.
        // For multi-word tokens, simple includes() is fine (already specific enough).
        const matched = token.includes(' ')
          ? normalised.includes(token)
          : new RegExp(`(?<![a-z])${escapeRegex(token)}(?![a-z])`, 'i').test(normalised);

        if (matched) {
          return rule.replyText;
        }
      }
    }
  }

  return null;  // no rule matched → caller should return fallback
}

/**
 * escapeRegex — escapes special regex characters in a literal string token
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT FALLBACK MESSAGE
// Exported so the route and any tests can reference the same string.
// ─────────────────────────────────────────────────────────────────────────────
export const FALLBACK_MESSAGE =
  "I'm still learning! Please contact our support team for more help.";
