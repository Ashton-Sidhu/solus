import type { PreviewSessionSnapshot } from "@t3tools/contracts";

type BrowserTab = Pick<PreviewSessionSnapshot, "navStatus">;

export function latestTabBy<T>(tabs: readonly T[], updatedAt: (tab: T) => string | number) {
  return tabs.reduce<T | null>(
    (latest, tab) => (latest === null || updatedAt(tab) > updatedAt(latest) ? tab : latest),
    null,
  );
}

export function browserTabUrl(tab: BrowserTab) {
  return tab.navStatus._tag === "Idle" ? "" : tab.navStatus.url;
}

export function browserTabTitleValue(tab: BrowserTab, newTab: () => string) {
  if (tab.navStatus._tag === "Idle") return newTab();
  if (tab.navStatus.title.trim()) return tab.navStatus.title;
  try {
    return new URL(tab.navStatus.url).host || tab.navStatus.url;
  } catch {
    return tab.navStatus.url;
  }
}
