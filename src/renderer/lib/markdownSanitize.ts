import {
  defaultSanitizeUrl,
  type SanitizeUrlFn,
} from "@humanspeak/svelte-markdown";

// @humanspeak/svelte-markdown sanitizes link/image hrefs at a single
// enforcement point in Parser before they reach any renderer — its default
// allowlist (http/https/mailto/tel/relative) blanks anything else to "".
// Solus emits custom-protocol links (plan://, work://, pr://, session://, file://) that
// MarkdownLink turns into in-app navigation, so we must allow them through;
// everything else defers to the library's default sanitizer.
const ALLOWED_CUSTOM_PROTOCOLS = /^\s*(plan|work|pr|session|file):/i;

export const markdownSanitizeUrl: SanitizeUrlFn = (url, context) => {
  if (typeof url === "string" && ALLOWED_CUSTOM_PROTOCOLS.test(url)) {
    return url;
  }
  return defaultSanitizeUrl(url, context);
};

// For remote-authored markdown — PR descriptions and comments written by
// arbitrary GitHub users. The in-app protocols above trigger navigation and
// file opens when clicked, so a hostile PR body must never get them through;
// this defers entirely to the library's default allowlist
// (http/https/mailto/tel/relative), which blanks everything else.
export const remoteMarkdownSanitizeUrl: SanitizeUrlFn = defaultSanitizeUrl;
