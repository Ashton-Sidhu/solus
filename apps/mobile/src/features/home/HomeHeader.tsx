// Adapted from T3 Code apps/mobile/src/features/home/HomeHeader.tsx (MIT, see UPSTREAM.md).
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

/**
 * On iOS the workspace toolbar (WorkspaceToolbar.ios.tsx) owns the Chats
 * header and the filters are pills above the list (ThreadListFilters), as
 * T3's `usesWorkspaceToolbar`. Android draws HomeHeader.android.tsx.
 */
export function HomeHeader(_props: HomeHeaderProps) {
  return null;
}
