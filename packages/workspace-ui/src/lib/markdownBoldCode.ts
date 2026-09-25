/** Give bold precedence when it encloses the entire contents of a code span. */
export function boldTextInCodeSpan(text: string): string | null {
  const marker = text.startsWith("**") && text.endsWith("**") ? "**"
    : text.startsWith("__") && text.endsWith("__") ? "__"
    : null;
  if (!marker) return null;

  const content = text.slice(2, -2);
  if (!content || content.trim() !== content || content.startsWith(marker[0]) || content.endsWith(marker[0]) || content.includes(marker)) return null;
  return content;
}
