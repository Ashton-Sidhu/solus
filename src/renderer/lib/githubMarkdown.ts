import type { MarkedExtension } from "@humanspeak/svelte-markdown";
import { markedAlert } from "@humanspeak/svelte-markdown/extensions/alert";

export const githubMarkdownExtensions: MarkedExtension[] = [markedAlert()];
