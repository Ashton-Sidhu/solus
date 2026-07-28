import type { SvelteMarkdownOptions } from "@humanspeak/svelte-markdown";

// Parser hooks disable svelte-markdown's append-only tail window. Keep the
// assistant configuration hook-free so a streamed response only reparses its
// changing tail.
export const assistantMarkdownOptions: SvelteMarkdownOptions = {};
