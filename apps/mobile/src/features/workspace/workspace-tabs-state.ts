// Adapted from T3 Code apps/mobile/src/features/workspace/workspace-tabs-state.ts (MIT, see UPSTREAM.md).

/**
 * The two list tabs of the mobile workspace (docs/plans/mobile-pull-requests.md).
 * The workspace owns this state, so it stays while a detail screen is pushed.
 * Android also shows Settings as a destination beside them; that selection
 * comes from the root stack, not from here (workspace-destinations.ts).
 *
 * T3 keeps a query, a search mode, and a scroll offset for each tab. Solus
 * keeps one query and one search mode, and a tab change clears them: each
 * tab shows its own native search field.
 *
 * Search modes (iOS): `resting` shows no search field; `active` shows it and
 * gives it focus; `expanded` keeps it shown after it lost focus.
 */
export type WorkspaceTab = 'chats' | 'pullRequests'
export type WorkspaceSearchMode = 'resting' | 'active' | 'expanded'

export interface WorkspaceTabsState {
  readonly selectedTab: WorkspaceTab
  /** The search text of the selected tab. */
  readonly query: string
  readonly searchMode: WorkspaceSearchMode
}

export const INITIAL_WORKSPACE_TABS_STATE: WorkspaceTabsState = { selectedTab: 'chats', query: '', searchMode: 'resting' }

export type WorkspaceTabsAction =
  | { readonly type: 'select'; readonly tab: WorkspaceTab }
  | { readonly type: 'query'; readonly query: string }
  | { readonly type: 'search' }
  | { readonly type: 'expand' }
  | { readonly type: 'cancel' }

export function workspaceTabsReducer(state: WorkspaceTabsState, action: WorkspaceTabsAction): WorkspaceTabsState {
  switch (action.type) {
    case 'select':
      return action.tab === state.selectedTab ? state : { selectedTab: action.tab, query: '', searchMode: 'resting' }
    case 'query':
      return action.query === state.query ? state : { ...state, query: action.query }
    case 'search':
      return state.searchMode === 'active' ? state : { ...state, searchMode: 'active' }
    case 'expand':
      return state.searchMode === 'active' ? { ...state, searchMode: 'expanded' } : state
    case 'cancel':
      return state.searchMode === 'resting' && state.query === '' ? state : { ...state, query: '', searchMode: 'resting' }
  }
}

export const WORKSPACE_TAB_LABELS = { chats: 'Chats', pullRequests: 'Pull Requests' } as const satisfies Record<WorkspaceTab, string>
