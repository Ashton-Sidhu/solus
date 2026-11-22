// Adapted from T3 Code apps/mobile/src/features/browser/browserTabs.ts (MIT, see UPSTREAM.md).
import { BROWSER_BLANK_URL, type BrowserPage } from "@solus/contracts/browser-types";

/** The page the viewer opens on: the one an agent of this session used last, else the newest. */
export function latestBrowserPage(
  pages: ReadonlyArray<BrowserPage>,
  sessionId: string,
): BrowserPage | null {
  const used = pages
    .filter((page) => page.agentUse?.sessionId === sessionId)
    .reduce<BrowserPage | null>(
      (latest, page) =>
        latest === null || page.agentUse!.at > latest.agentUse!.at ? page : latest,
      null,
    );
  return (
    used ??
    pages.reduce<BrowserPage | null>(
      (latest, page) => (latest === null || page.createdAt > latest.createdAt ? page : latest),
      null,
    )
  );
}

export function browserPageUrl(page: BrowserPage) {
  return page.url === BROWSER_BLANK_URL ? "" : page.url;
}

export function browserPageTitle(page: BrowserPage) {
  if (page.title.trim()) return page.title;
  const url = browserPageUrl(page);
  if (!url) return "New tab";
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** What the viewer says about who is using the page. Solus has no control lease: a person and an agent share it. */
export function browserPageStatusLabel(page: BrowserPage): string {
  if (page.devToolsOpen)
    return "DevTools are open on this page. Close them on the desktop to use it here.";
  if (page.hostKind === "none") return "Nothing is showing this page now.";
  if (page.problem && page.problem.kind !== "no-surface") return page.problem.message;
  if (page.agentUse && page.agentUse.running > 0) return "An agent is using this page.";
  return "Tap to click. Drag to scroll.";
}
