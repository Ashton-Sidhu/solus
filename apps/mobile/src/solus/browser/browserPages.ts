import {
  browserTabTitleValue,
  browserTabUrl,
  latestTabBy,
} from "../../features/browser/browserTabValues";
// Adapted from T3 Code apps/mobile/src/features/browser/browserTabs.ts (MIT, see UPSTREAM.md).
import { BROWSER_BLANK_URL, type BrowserPage } from "@solus/contracts/browser-types";

/** The page the viewer opens on: the one an agent of this session used last, else the newest. */
export function latestBrowserPage(
  pages: ReadonlyArray<BrowserPage>,
  sessionId: string,
): BrowserPage | null {
  const used = pages.filter((page) => page.agentUse?.sessionId === sessionId);
  return (
    latestTabBy(used, (page) => page.agentUse!.at) ?? latestTabBy(pages, (page) => page.createdAt)
  );
}

function browserTab(page: BrowserPage) {
  return {
    navStatus:
      page.url === BROWSER_BLANK_URL
        ? { _tag: "Idle" as const }
        : { _tag: "Success" as const, url: page.url, title: page.title },
  };
}

export function browserPageUrl(page: BrowserPage) {
  return browserTabUrl(browserTab(page));
}

export function browserPageTitle(page: BrowserPage, newTab = () => "New tab") {
  return browserTabTitleValue(browserTab(page), () => (page.title.trim() ? page.title : newTab()));
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
