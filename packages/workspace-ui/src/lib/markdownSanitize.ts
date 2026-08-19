import {
  defaultSanitizeUrl,
  type SanitizeUrlFn,
} from "@humanspeak/svelte-markdown";
import { z } from "zod";

const markdownUrlSchema = z.string();

// @humanspeak/svelte-markdown sanitizes link/image hrefs at a single
// enforcement point in Parser before they reach any renderer — its default
// allowlist (http/https/mailto/tel/relative) blanks anything else to "".
// Solus emits custom-protocol links (plan://, work://, pr://, session://, file://) that
// MarkdownLink turns into in-app navigation, so we must allow them through;
// everything else defers to the library's default sanitizer.
const ALLOWED_CUSTOM_PROTOCOLS = /^\s*(plan|work|pr|session|file):/i;

export const markdownSanitizeUrl: SanitizeUrlFn = (url, context) => {
  const parsed = markdownUrlSchema.safeParse(url);
  if (parsed.success && ALLOWED_CUSTOM_PROTOCOLS.test(parsed.data)) {
    return parsed.data;
  }
  return defaultSanitizeUrl(url, context);
};

// For remote-authored markdown — PR descriptions and comments written by
// arbitrary GitHub users. The in-app protocols above trigger navigation and
// file opens when clicked, so a hostile PR body must never get them through;
// this defers entirely to the library's default allowlist
// (http/https/mailto/tel/relative), which blanks everything else.
export const remoteMarkdownSanitizeUrl: SanitizeUrlFn = defaultSanitizeUrl;
