// Adapted from T3 Code packages/shared/src/composerInlineTokens.ts (MIT, see UPSTREAM.md).
// T3's `MENTION_TOKEN_REGEX` and its bare `@scope/package` rule as one pattern
// that Enriched's text link recognition runs natively.

/**
 * An `@path` or `@"quoted path"` mention in user message text. Enriched gives
 * the matched text, `@` included, as the link URL.
 *
 * T3's rule: the `@` starts the text or follows whitespace; a bare path is
 * every character up to the next whitespace, `@`, or `"`, and whitespace must
 * follow it. Here the end of the text also ends a mention, as T3's sent-prompt
 * skill pattern allows (`SKILL_MENTION_PATTERN`). A bare path that reads as a
 * lowercase package (`@scope/package`, `@src/foo.ts`) stays prose, because
 * T3's autocomplete writes such paths as file links.
 *
 * The pattern compiles in JavaScript, ICU (iOS), and java.util.regex
 * (Android). The lookbehind holds no `*`, `+`, or `{`, which Enriched refuses.
 * The package lookahead uses `?` where T3 has `*`: the two match the same text,
 * and `*` backtracks exponentially on a long path that fails.
 */
export const FILE_MENTION_REGEX =
  /(?<!\S)@(?:"(?:\\.|[^"\\])+"|(?![a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[^\s@"]+)?(?!\S))[^\s@"]+)(?!\S)/;

const ANCHORED_MENTION = new RegExp(`^(?:${FILE_MENTION_REGEX.source})$`);
const QUOTED_MENTION = /^@"((?:\\.|[^"\\])+)"$/;

/** The path a mention URL names, or null when `url` is not a mention. */
export function fileMentionPath(url: string): string | null {
  if (!ANCHORED_MENTION.test(url)) return null;
  const quoted = QUOTED_MENTION.exec(url);
  return quoted ? quoted[1]!.replace(/\\(.)/g, "$1") : url.slice(1);
}
