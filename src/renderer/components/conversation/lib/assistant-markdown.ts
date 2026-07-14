import type { MarkedExtension } from "@humanspeak/svelte-markdown";
import { walkTokens, type Token } from "marked";

export function preserveUnmatchedHtml(token: Token): void {
  walkTokens([token], (nestedToken) => {
    if (nestedToken.type !== "html" || "tag" in nestedToken) return;

    nestedToken.type = "escape";
    nestedToken.text = nestedToken.raw;
  });
}

export const assistantMarkdownExtensions: MarkedExtension[] = [
  { walkTokens: preserveUnmatchedHtml },
];
