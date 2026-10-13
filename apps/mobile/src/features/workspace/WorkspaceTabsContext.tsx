// Adapted from T3 Code apps/mobile/src/features/workspace/WorkspaceTabsContext.tsx (MIT, see UPSTREAM.md).
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'

import { useApp } from '../../app/app-context'
import {
  PULL_REQUEST_LIST_FILTERS_KEY,
  readPullRequestListPreferences,
  type PullRequestListPreferences,
} from './list-preferences'
import {
  INITIAL_WORKSPACE_TABS_STATE,
  workspaceTabsReducer,
  type WorkspaceTab,
  type WorkspaceTabsAction,
  type WorkspaceTabsState,
} from './workspace-tabs-state'

export interface WorkspaceTabs {
  readonly state: WorkspaceTabsState
  readonly dispatch: Dispatch<WorkspaceTabsAction>
  /** The tab shown now, read when a retained iOS tab must not act for the other one. */
  readonly isTabActive: (tab: WorkspaceTab) => boolean
  /** The Pull Requests tab's filters, kept on the device. */
  readonly pullRequestPreferences: PullRequestListPreferences
  readonly setPullRequestPreferences: Dispatch<SetStateAction<PullRequestListPreferences>>
}

export const WorkspaceTabsContext = createContext<WorkspaceTabs | null>(null)

export function useWorkspaceTabs(): WorkspaceTabs {
  const workspace = use(WorkspaceTabsContext)
  if (!workspace) throw new Error('useWorkspaceTabs needs a WorkspaceTabsProvider')
  return workspace
}

/**
 * The tab controller and its list screens share this state across native
 * container changes: the iOS tab bar, the iPad columns, and Android's
 * navigation bar all read it. One provider wraps the root navigator.
 */
export function WorkspaceTabsProvider(props: { readonly children: ReactNode }) {
  const app = useApp()
  const [state, dispatch] = useReducer(workspaceTabsReducer, INITIAL_WORKSPACE_TABS_STATE)
  const activeTab = useRef(state.selectedTab)
  useLayoutEffect(() => {
    activeTab.current = state.selectedTab
  }, [state.selectedTab])
  const isTabActive = useCallback((tab: WorkspaceTab) => activeTab.current === tab, [])
  const [pullRequestPreferences, setPullRequestPreferences] = useState(() =>
    readPullRequestListPreferences(app.platform.storage),
  )
  const savedPullRequestPreferences = useRef(pullRequestPreferences)
  useEffect(() => {
    if (savedPullRequestPreferences.current === pullRequestPreferences) return
    savedPullRequestPreferences.current = pullRequestPreferences
    app.platform.storage.setItem(PULL_REQUEST_LIST_FILTERS_KEY, JSON.stringify(pullRequestPreferences))
  }, [app, pullRequestPreferences])
  const context = useMemo(
    () => ({ state, dispatch, isTabActive, pullRequestPreferences, setPullRequestPreferences }),
    [state, isTabActive, pullRequestPreferences],
  )
  return <WorkspaceTabsContext value={context}>{props.children}</WorkspaceTabsContext>
}
