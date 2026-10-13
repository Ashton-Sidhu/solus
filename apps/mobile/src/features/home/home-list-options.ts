// Adapted from T3 Code apps/mobile/src/features/home/home-list-options.ts (MIT, see UPSTREAM.md).
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type Dispatch,
  type SetStateAction,
} from "react";

import { useApp } from "../../app/app-context";
import {
  DEFAULT_THREAD_LIST_FILTERS,
  readThreadListFilters,
  THREAD_LIST_FILTERS_KEY,
  type ThreadListFilters,
} from "../workspace/list-preferences";

/**
 * The thread list's filters. T3 also carries a project sort order and a
 * grouping preference here; Solus has neither preference, so projects group
 * by repository and sort by activity.
 */
export interface HomeListOptions {
  /** The Solus host id the list is narrowed to (a T3 environment). */
  readonly selectedEnvironmentId: string | null;
  /** The project scope key the list is narrowed to. */
  readonly selectedProjectKey: string | null;
}

function homeListOptions(filters: ThreadListFilters): HomeListOptions {
  return { selectedEnvironmentId: filters.environmentId, selectedProjectKey: filters.projectKey };
}

interface HomeListOptionsContextValue {
  readonly options: HomeListOptions;
  readonly setOptions: Dispatch<SetStateAction<HomeListOptions>>;
}

const HomeListOptionsContext = createContext<HomeListOptionsContextValue | null>(null);

/**
 * Keeps list preferences stable while the app moves between compact and split shells.
 * Filters start from the saved preference, and changes are saved for the next launch.
 */
export function HomeListOptionsProvider({ children }: PropsWithChildren) {
  const app = useApp();
  const [options, setOptions] = useState(() =>
    homeListOptions(readThreadListFilters(app.platform.storage)),
  );
  const saved = useRef(options);
  useEffect(() => {
    if (saved.current === options) return;
    saved.current = options;
    const filters: ThreadListFilters = {
      environmentId: options.selectedEnvironmentId,
      projectKey: options.selectedProjectKey,
    };
    app.platform.storage.setItem(THREAD_LIST_FILTERS_KEY, JSON.stringify(filters));
  }, [app, options]);
  const value = useMemo(() => ({ options, setOptions }), [options]);
  return createElement(HomeListOptionsContext, { value }, children);
}

/**
 * The saved filters, with the host resolved against the paired hosts. A saved
 * host or project that is not available is not shown as selected, but it
 * stays saved: it applies again when its host comes back. The caller
 * resolves `selectedProjectKey` against the projects it can show.
 */
export function useHomeListOptions(availableEnvironmentIds: ReadonlySet<string>) {
  const shared = useContext(HomeListOptionsContext);
  const [localOptions, setLocalOptions] = useState<HomeListOptions>(() =>
    homeListOptions(DEFAULT_THREAD_LIST_FILTERS),
  );
  const options = shared?.options ?? localOptions;
  const setOptions = shared?.setOptions ?? setLocalOptions;
  const selectedEnvironmentId =
    options.selectedEnvironmentId !== null &&
    availableEnvironmentIds.has(options.selectedEnvironmentId)
      ? options.selectedEnvironmentId
      : null;
  const resolvedOptions: HomeListOptions =
    selectedEnvironmentId === options.selectedEnvironmentId
      ? options
      : { ...options, selectedEnvironmentId };

  const setSelectedEnvironmentId = useCallback(
    (value: string | null) => {
      setOptions((current) => ({ ...current, selectedEnvironmentId: value }));
    },
    [setOptions],
  );
  const setSelectedProjectKey = useCallback(
    (value: string | null) => {
      setOptions((current) => ({ ...current, selectedProjectKey: value }));
    },
    [setOptions],
  );
  return {
    options: resolvedOptions,
    setSelectedEnvironmentId,
    setSelectedProjectKey,
  } as const;
}
