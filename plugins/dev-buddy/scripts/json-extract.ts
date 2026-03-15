/**
 * Extract structured JSON from an AI model's response string.
 *
 * AI models often wrap JSON output in markdown code fences. This utility
 * extracts the structured data regardless of formatting.
 *
 * Parsing strategy (in order):
 * 1. If input is not a string, return it as-is (already structured)
 * 2. Try JSON.parse(raw) — handles clean JSON output
 * 3. Extract from markdown code fences (```json ... ``` or ``` ... ```) — last valid block wins
 * 4. Return null if no valid JSON found
 */
export function extractJsonFromResult(raw: unknown): unknown | null {
  // Already structured (object, array, etc.)
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  if (!raw.trim()) return null;

  // Strategy 1: direct parse
  try {
    return JSON.parse(raw);
  } catch { /* not raw JSON, try code fences */ }

  // Strategy 2: extract from code fences (last valid block wins)
  const codeBlockRegex = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = codeBlockRegex.exec(raw)) !== null) {
    blocks.push(m[1].trim());
  }

  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(blocks[i]);
    } catch { /* try next block */ }
  }

  return null;
}
