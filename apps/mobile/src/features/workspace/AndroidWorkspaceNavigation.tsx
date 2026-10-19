// Adapted from T3 Code apps/mobile/src/features/workspace/AndroidWorkspaceNavigation.tsx (MIT, see UPSTREAM.md).

/** Other clients own their workspace navigation chrome. */
export function AndroidWorkspaceNavigation(_props: { readonly settingsOpen: boolean }) {
  return null
}

export function AndroidWorkspaceRail(_props: {
  readonly split: boolean
  readonly visible: boolean
  readonly settingsOpen: boolean
  readonly onStartNewTask: () => void
  readonly onSelect: () => void
}) {
  return null
}

export const ANDROID_WORKSPACE_RAIL_WIDTH = 72
