// Adapted from T3 Code apps/mobile/src/lib/enrichedLinkPresentation.ts (MIT, see UPSTREAM.md).
// No context chips or skills: Solus Markdown draws pills for file links only.
import { themeAccentWithContrast, type MobileThemeVariables } from "./mobileTheme";

/** T3's `mention` chip accent (`composerChipPresentation.ts`). */
const MENTION_CHIP_ACCENT = "#0096af";
const CHIP_CONTRAST = 5;
const readableMentionColors = new Map<string, string>();

/**
 * The mention chip keeps one color per theme so it looks the same in a message,
 * a reply, and the composer, so it must read on all of them. The accent as it
 * is reads about 3.5:1 on a light surface; this keeps its hue at 5:1
 * (pingdotgg/t3code#22585).
 */
export function mentionChipColor(theme: MobileThemeVariables): string {
  const surfaces = [
    theme["--color-user-bubble"],
    theme["--color-thread-canvas"],
    theme["--color-composer-surface"],
  ];
  const key = surfaces.join();
  let readable = readableMentionColors.get(key);
  if (readable === undefined) {
    readable = themeAccentWithContrast(MENTION_CHIP_ACCENT, surfaces, CHIP_CONTRAST);
    readableMentionColors.set(key, readable);
  }
  return readable;
}

export function enrichedLinkVariantPattern(url: string) {
  return `^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/** Conservative recognition for Enriched's whole-span inline-code link hook. */
export const ENRICHED_INLINE_FILE_LINK_REGEX =
  /^(?!\S*:\/\/)(?:(?:\.{1,2}[\\/]|~[\\/]|\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|private|root|usr|bin|sbin|lib|lib64|srv|dev|proc|sys|run|boot|media|workspace|workspaces)\/|[A-Za-z]:[\\/])[^\s`]+|(?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+:\d+(?::\d+)?)$/;
