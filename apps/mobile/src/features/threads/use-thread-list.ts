import { useCallback, useEffect, useRef } from "react";

import { useApp, useListened } from "../../app/app-context";
import { threadUndoNotices } from "../home/thread-undo-notice";
import { sharedNoticeMessage } from "./shared-with-you";
import type { SolusThreadShell } from "./thread-directory";
import type { ThreadListState } from "./thread-list-state";
import { threadTitle } from "./threadListV2";

/** The app's one `ThreadListState`, shared by the compact Home list and the iPad sidebar. */
export function useThreadListState(): ThreadListState {
  return useApp().threadList;
}

/** A burst of status changes (a turn starting and settling) reads the list once. */
const STATUS_RELOAD_DELAY_MS = 600;

/** Reads every saved host's sessions and list state; dials a host on first use. */
export function useReloadThreadLists(): () => void {
  const app = useApp();
  const list = useThreadListState();
  return useCallback(() => {
    for (const host of app.registry.hosts()) {
      app.connections.connection(host.id);
      void app.threads.load(host.id);
      list.follow(host.id);
    }
  }, [app, list]);
}

/**
 * Keeps every host's sessions current while the workspace is mounted: reads a
 * host when it connects (again) and shortly after the host reports a session's
 * status, title, or shares changed. Mount once, in the workspace
 * layout; a route screen also reloads when it comes back into view.
 */
export function useThreadListRefresh(): void {
  const app = useApp();
  const reloadAll = useReloadThreadLists();
  // A string, so an unrelated connection change does not re-run the effects.
  const connectedHosts = useListened(app.connections.changes, () =>
    app.registry
      .hosts()
      .filter((host) => app.connections.state(host.id)?.readiness === "ready")
      .map((host) => `${host.id}:${app.connections.state(host.id)?.sessionGeneration ?? 0}`)
      .join("\n"),
  );

  useEffect(() => {
    reloadAll();
  }, [connectedHosts, reloadAll]);

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const stops = app.registry.hosts().flatMap((host) => {
      const connection = app.connections.connection(host.id);
      if (!connection) return [];
      const reloadSoon = () => {
        clearTimeout(timers.get(host.id));
        timers.set(
          host.id,
          setTimeout(() => void app.threads.load(host.id), STATUS_RELOAD_DELAY_MS),
        );
      };
      // A name generated or typed on any client lands in the record's `customTitle`.
      return [
        connection.events.subscribe("session.statusChanged", reloadSoon),
        connection.events.subscribe("session.titleChanged", reloadSoon),
        // A share of a session lists it, or takes it out, for this person
        // (docs/plans/shared-with-you.md §4.4).
        connection.events.subscribe("share.changed", ({ resource }) => {
          if (resource.kind === "session") reloadSoon();
        }),
      ];
    });
    return () => {
      for (const stop of stops) stop();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [app, connectedHosts]);
}

/**
 * Shows a notice with Open when a read finds a session newly shared with this
 * person (docs/plans/shared-with-you.md §5, §6): the newest one, when a read
 * brings several. Mount once, beside `useThreadListRefresh`.
 */
export function useSharedWithYouNotices(open: (thread: SolusThreadShell) => void): void {
  const app = useApp();
  // Open runs later, from the notice: it takes the navigation of that moment.
  const latestOpen = useRef(open);
  useEffect(() => {
    latestOpen.current = open;
  }, [open]);
  useEffect(
    () =>
      app.threads.subscribeShares((threads) => {
        const thread = threads[0]!;
        threadUndoNotices.show({
          message: sharedNoticeMessage(thread.record, threadTitle(thread.record)),
          actionLabel: "Open",
          threadKey: thread.key,
          act: () => latestOpen.current(thread),
        });
      }),
    [app],
  );
}
