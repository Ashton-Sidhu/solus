import {
  defaultSanitizeUrl,
  type SanitizeUrlFn,
} from "@humanspeak/svelte-markdown";

// @humanspeak/svelte-markdown sanitizes link/image hrefs at a single
// enforcement point in Parser before they reach any renderer — its default
// allowlist (http/https/mailto/tel/relative) blanks anything else to "".
// Solus emits custom-protocol links (plan://, work://, file://) that
// MarkdownLink turns into in-app navigation, so we must allow them through;
// everything else defers to the library's default sanitizer.
const ALLOWED_CUSTOM_PROTOCOLS = /^\s*(plan|work|file):/i;

export const markdownSanitizeUrl: SanitizeUrlFn = (url, context) => {
  if (typeof url === "string" && ALLOWED_CUSTOM_PROTOCOLS.test(url)) {
    return url;
  }
  return defaultSanitizeUrl(url, context);
};
