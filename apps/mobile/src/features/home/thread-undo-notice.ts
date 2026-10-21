// Adapted from T3 Code apps/mobile/src/features/home/thread-undo-notice.ts (MIT, see UPSTREAM.md).
import { Listeners } from "../../lib/listeners";

/** What a list action did, in the notice: "Settled thread". */
export type ThreadUndoAction = "Settled" | "Snoozed" | "Archived";

export interface ThreadUndoNotice {
  readonly action: ThreadUndoAction;
  readonly threadKey: string;
  /** The inverse command: un-settle, wake, or return to the list. */
  readonly undo: () => void;
}

/** How long Undo is offered (pingdotgg/t3code#21401). */
export const THREAD_UNDO_NOTICE_MS = 5_000;

/**
 * The one Undo the thread lists offer, after a settle, snooze, or archive
 * succeeds on the host, as desktop and web offer Undo after a snooze or an
 * archive. A newer action replaces it. A new action on the same thread
 * dismisses it: its Undo would act against that action. One store serves Home
 * and the navigation sidebar, so an action in one dismisses the other's notice.
 */
export class ThreadUndoNotices {
  private readonly changes = new Listeners();
  private notice: ThreadUndoNotice | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;

  readonly subscribe = this.changes.subscribe;

  readonly current = (): ThreadUndoNotice | null => this.notice;

  show(notice: ThreadUndoNotice): void {
    this.clearExpiry();
    this.notice = notice;
    this.expiry = setTimeout(() => this.dismiss(), THREAD_UNDO_NOTICE_MS);
    this.changes.notify();
  }

  /** Dismiss the notice; with a thread key, only that thread's notice. */
  dismiss(threadKey?: string): void {
    if (this.notice === null) return;
    if (threadKey !== undefined && this.notice.threadKey !== threadKey) return;
    this.clearExpiry();
    this.notice = null;
    this.changes.notify();
  }

  /** Runs the shown notice's Undo once: a second press finds no notice. */
  undo(): void {
    const notice = this.notice;
    if (notice === null) return;
    this.dismiss();
    notice.undo();
  }

  private clearExpiry(): void {
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
  }
}

export const threadUndoNotices = new ThreadUndoNotices();
