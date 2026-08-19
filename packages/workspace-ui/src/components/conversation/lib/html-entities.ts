const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
} satisfies Record<string, string>;

export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:amp|lt|gt|quot|#39);/g,
    (entity) => HTML_ENTITIES[entity],
  );
}
