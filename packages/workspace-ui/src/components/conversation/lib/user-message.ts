const COLLAPSED_CHARACTER_LIMIT = 700;
const COLLAPSED_LINE_LIMIT = 12;

/**
 * Keep routine prompts scannable while giving pasted specs and logs a compact
 * footprint in the transcript. Explicit lines catch short, vertically long
 * content that a character limit alone would miss.
 */
export function shouldCollapseUserMessage(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;

  return (
    trimmed.length > COLLAPSED_CHARACTER_LIMIT ||
    trimmed.split(/\r?\n/).length > COLLAPSED_LINE_LIMIT
  );
}
