import type { LegendListRef } from "@legendapp/list/react-native";

export function pullRequestTabOffset(
  current: number,
  saved: number | undefined,
  headerEnd: number,
) {
  return current < headerEnd - 0.5 ? current : Math.max(headerEnd, saved ?? headerEnd);
}

/** Keep the toolbar request pending until the overview row and its section have mounted. */
export function scrollToPullRequestFiles(
  overview: Pick<LegendListRef, "scrollToKey"> | null | undefined,
  filesOffset: number | null,
  topInset: number,
): boolean {
  if (!overview || filesOffset === null) return false;
  void overview.scrollToKey({
    key: "overview:body",
    viewPosition: 0,
    viewOffset: topInset - filesOffset,
    animated: true,
  });
  return true;
}
