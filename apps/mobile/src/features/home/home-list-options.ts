// Adapted from T3 Code apps/mobile/src/features/home/home-list-options.ts (MIT, see UPSTREAM.md).
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
  type Dispatch,
  type SetStateAction,
} from "react";

/**
 * The thread list's filters. T3 also carries a project sort order and a
 * grouping preference here; Solus has neither preference, so projects group
 * by repository and sort by activity.
 */
export interface HomeListOptions {
  /** The Solus host id the list is narrowed to (a T3 environment). */
  readonly selectedEnvironmentId: string | null;
}

function defaultHomeListOptions(): HomeListOptions {
  return { selectedEnvironmentId: null };
}

interface HomeListOptionsContextValue {
  readonly options: HomeListOptions;
  readonly setOptions: Dispatch<SetStateAction<HomeListOptions>>;
}

const HomeListOptionsContext = createContext<HomeListOptionsContextValue | null>(null);

/** Keeps list preferences stable while the app moves between compact and split shells. */
export function HomeListOptionsProvider({ children }: PropsWithChildren) {
  const [options, setOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const value = useMemo(() => ({ options, setOptions }), [options]);
  return createElement(HomeListOptionsContext, { value }, children);
}

export function useHomeListOptions(availableEnvironmentIds: ReadonlySet<string>) {
  const shared = useContext(HomeListOptionsContext);
  const [localOptions, setLocalOptions] = useState<HomeListOptions>(defaultHomeListOptions);
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
  return {
    options: resolvedOptions,
    setSelectedEnvironmentId,
  } as const;
}
