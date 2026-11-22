import { solusPrList, sourceScope } from "../../solus/source-control";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  editHeldPullRequestListEntries,
  pullRequestPendingEditsFor,
} from "@t3tools/client-runtime/state/pull-requests";
import { RegistryContext, useAtomMount, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestListInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { msg, useMessages } from "gt-react-native";
import { use, useMemo } from "react";
import { environmentCatalog } from "../../connection/catalog";
import { m } from "../../i18n/messages";
import { pullRequestListPagesFamily, pullRequestListPagesKey } from "../../state/pull-requests";
import {
  appendPullRequestListPage,
  mergeEnvironmentPullRequestPages,
  nextPullRequestListInput,
  patchPullRequestListEntry,
  pullRequestListHead,
  shownPullRequestListPages,
  type EnvironmentPullRequestListEntry,
  type PullRequestListPages,
} from "./pullRequestList";

type ListTarget = { readonly environmentId: EnvironmentId; readonly input: PullRequestListInput };
type Read = <A>(atom: Atom.Atom<A>) => A;

/** The head the list query holds now, cached or answered. */
function currentHead(read: Read, target: ListTarget) {
  return AsyncResult.getOrElse(read(solusPrList(target)), () => null);
}

function currentPages(read: Read, target: ListTarget): PullRequestListPages | null {
  return shownPullRequestListPages(
    read(pullRequestListPagesFamily(pullRequestListPagesKey(target))),
    currentHead(read, target),
  );
}

const sourcesFamily = Atom.family((key: string) => {
  const targets: readonly ListTarget[] = JSON.parse(key);
  return Atom.make((get) =>
    targets.map((target) => {
      const pages = currentPages(get, target);
      return {
        target,
        result: get(solusPrList(target)),
        pages:
          pages === null
            ? null
            : {
                ...pages,
                entries: editHeldPullRequestListEntries(target.input, pages.entries, (entry) =>
                  get(pullRequestPendingEditsFor(target.environmentId, entry)),
                ),
              },
      };
    }),
  );
});

function continuations(registry: AtomRegistry.AtomRegistry, targets: readonly ListTarget[]) {
  return targets.flatMap((target) => {
    const pages = currentPages((atom) => registry.get(atom), target);
    const input = pages && nextPullRequestListInput(pages, target.input);
    return pages && input ? [{ target, pages, input }] : [];
  });
}

async function loadNextPages(
  registry: AtomRegistry.AtomRegistry,
  targets: readonly ListTarget[],
  retry: boolean,
  signal: AbortSignal,
) {
  const responses = await Promise.allSettled(
    continuations(registry, targets).map(async ({ target, pages, input }) => {
      const response = await executeAtomQuery(registry, solusPrList({ ...target, input }), {
        signal,
        refresh: retry,
        reportFailure: false,
      });
      if (signal.aborted) return;
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      if (response.value.errors.length)
        throw new Error(response.value.errors.map((error) => error.message).join("\n"));
      const pagesAtom = pullRequestListPagesFamily(pullRequestListPagesKey(target));
      const next = appendPullRequestListPage(
        currentPages((atom) => registry.get(atom), target) ?? pages,
        response.value,
        input,
      );
      registry.set(pagesAtom, next);
      if (
        input.cursors &&
        Object.keys(next.nextCursors).length &&
        JSON.stringify(Object.entries(input.cursors).sort()) ===
          JSON.stringify(Object.entries(next.nextCursors).sort())
      )
        throw new Error(m(msg("Couldn't advance the list. Try again.")));
    }),
  );
  return requestErrors(responses);
}

async function refreshHeads(
  registry: AtomRegistry.AtomRegistry,
  targets: readonly ListTarget[],
  signal: AbortSignal,
) {
  const responses = await Promise.allSettled(
    targets.map(async (target) => {
      if (signal.aborted) return;
      const response = await executeAtomQuery(registry, solusPrList(target), {
        refresh: true,
        signal,
        reportFailure: false,
      });
      if (signal.aborted) return;
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      registry.set(
        pullRequestListPagesFamily(pullRequestListPagesKey(target)),
        pullRequestListHead(null, response.value),
      );
    }),
  );
  return requestErrors(responses);
}

// One load of each kind per list scope. The atoms are not kept alive, so leaving a scope (a
// filter change, unmount) interrupts its load and aborts the requests.
const pageLoadFamily = Atom.family((scopeKey: string) => {
  const targets: readonly ListTarget[] = JSON.parse(scopeKey);
  return Atom.fn((retry: boolean, get) =>
    Effect.promise((signal) => loadNextPages(get.registry, targets, retry, signal)),
  );
});
const refreshLoadFamily = Atom.family((scopeKey: string) => {
  const targets: readonly ListTarget[] = JSON.parse(scopeKey);
  return Atom.fn((_: void, get) =>
    Effect.promise((signal) => refreshHeads(get.registry, targets, signal)),
  );
});

// Changes when any of the scope's environments brings up a new session.
const sessionsFamily = Atom.family((scopeKey: string) =>
  Atom.make((get) =>
    (JSON.parse(scopeKey) as readonly ListTarget[])
      .map(({ environmentId }) => get(environmentCatalog.sessionGenerationAtom(environmentId)))
      .join(),
  ),
);

const settledError = (result: AsyncResult.AsyncResult<string | null, never>) =>
  AsyncResult.isSuccess(result) && !result.waiting ? result.value : null;

export function usePullRequestList(targets: readonly ListTarget[]) {
  const messages = useMessages();
  const registry = use(RegistryContext);
  const scopeKey = JSON.stringify(
    targets.map((t) => ({ ...t, scope: sourceScope(t.environmentId) })),
  );
  const sources = useAtomValue(sourcesFamily(scopeKey));
  const pageAtom = pageLoadFamily(scopeKey);
  const refreshAtom = refreshLoadFamily(scopeKey);
  const page = useAtomValue(pageAtom);
  const refresh = useAtomValue(refreshAtom);
  const loadError = settledError(page);

  // A page or refresh asked for while an environment was unreachable fails at once, and its
  // error stops loading on scroll. Once it is back, ask for the page again; a refresh's error is
  // stale by then because the list queries re-run on reconnect.
  // A listener alone does not compute the atom, so nothing would follow the connections.
  useAtomMount(sessionsFamily(scopeKey));
  useAtomSubscribe(sessionsFamily(scopeKey), () => {
    const pageResult = registry.get(pageAtom);
    const refreshResult = registry.get(refreshAtom);
    if (settledError(refreshResult) !== null) registry.set(refreshAtom, Atom.Reset);
    else if (settledError(pageResult) !== null && !refreshResult.waiting)
      registry.set(pageAtom, true);
  });

  // Read from the registry, not the render: a second onEndReached before React re-renders must
  // see the load the first one started.
  const loadMore = (retry = false) => {
    const pageResult = registry.get(pageAtom);
    const refreshResult = registry.get(refreshAtom);
    if (pageResult.waiting || refreshResult.waiting) return;
    if (!retry && settledError(pageResult)) return;
    if (!continuations(registry, targets).length) return;
    registry.set(refreshAtom, Atom.Reset);
    registry.set(pageAtom, retry);
  };

  const onRefresh = () => {
    if (!targets.length || registry.get(refreshAtom).waiting) return;
    registry.set(pageAtom, Atom.Reset);
    registry.set(refreshAtom, undefined);
  };

  const data = useMemo(
    () =>
      mergeEnvironmentPullRequestPages(
        sources.flatMap(({ target, pages }) =>
          pages ? [{ environmentId: target.environmentId, pages }] : [],
        ),
      ),
    [sources],
  );
  // Solus returns the addition and deletion counts with each list row.
  const entries = data.entries;

  const updateEntry = (
    entry: EnvironmentPullRequestListEntry,
    patch: Partial<EnvironmentPullRequestListEntry>,
  ) => {
    const target = targets.find((target) => target.environmentId === entry.environmentId);
    if (!target) return;
    const pagesAtom = pullRequestListPagesFamily(pullRequestListPagesKey(target));
    const read = <A>(atom: Atom.Atom<A>) => registry.get(atom);
    const patched = patchPullRequestListEntry(
      read(pagesAtom),
      currentHead(read, target),
      entry,
      patch,
      Date.now(),
    );
    if (patched) registry.set(pagesAtom, patched);
    registry.refresh(solusPrList(target));
  };
  const errors = useMemo(
    () =>
      sources.flatMap(({ target, result }) => {
        if (result._tag !== "Failure") return [];
        const cause = Cause.squash(result.cause);
        return [
          {
            environmentId: target.environmentId,
            projectTitle: "",
            message:
              cause instanceof Error
                ? (errorDisplayMessage(cause, messages) ?? cause.message)
                : messages(msg("Couldn't load pull requests.")),
          },
        ];
      }),
    [sources, messages],
  );
  const listing = useMemo(
    () => ({ ...data, entries, errors: [...data.errors, ...errors] }),
    [data, entries, errors],
  );
  return {
    data: listing,
    entries,
    error: errors.map((error) => error.message).join("\n") || null,
    isPending: sources.some(({ result }) => result.waiting) && !data.entries.length,
    continued: data.continued,
    loadMore,
    onRefresh,
    updateEntry,
    refreshing: refresh.waiting,
    loadingMore: page.waiting,
    loadMoreError: loadError,
    hasMore: sources.some(
      ({ pages, target }) => pages && nextPullRequestListInput(pages, target.input),
    ),
  };
}

function requestErrors(results: readonly PromiseSettledResult<unknown>[]) {
  return (
    results
      .flatMap((result) =>
        result.status === "rejected"
          ? [
              result.reason instanceof Error
                ? (errorDisplayMessage(result.reason, m) ?? result.reason.message)
                : m(msg("Couldn't load pull requests.")),
            ]
          : [],
      )
      .join("\n") || null
  );
}
