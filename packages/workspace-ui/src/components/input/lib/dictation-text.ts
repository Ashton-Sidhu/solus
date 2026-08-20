/** Return speech for a selection, with separators from the surrounding text. */
export function dictationInsertion(
  transcript: string,
  textBefore: string,
  textAfter = "",
): string {
  const text = transcript.trim();
  if (!text) return "";
  const leading = textBefore && !/\s$/.test(textBefore) ? " " : "";
  const trailing = textAfter && !/^\s/.test(textAfter) ? " " : "";
  return `${leading}${text}${trailing}`;
}
