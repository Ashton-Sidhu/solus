import { shareRoleLabel } from "@solus/client-core/notifications/presentation";
import type { SessionRecord } from "@solus/contracts/types";

/**
 * Shared with you on the phone (docs/plans/shared-with-you.md §6): the
 * sessions in this person's list that another person owns, and the notice a
 * new direct share shows.
 *
 * The owner decides the group (§2 rule 1). A host gives the reader the role
 * `owner` exactly when the record's `ownerKey` is the reader
 * (`standingOf`, `admission/access.ts`), so the role answers "not mine"
 * without a second read of who this person is on each host. A record with no
 * role (a host's own store, an older host) is the reader's own.
 */
export function isSharedWithReader(record: Pick<SessionRecord, "role">): boolean {
  return record.role !== undefined && record.role !== "owner";
}

/** "Can edit", for a shared session's row and notice; null on the reader's own. */
export function sharedRoleLabel(record: Pick<SessionRecord, "role">): string | null {
  const role = record.role;
  if (role === undefined || role === "owner" || role === "none") return null;
  return shareRoleLabel(role);
}

/** The notice a new share shows, for the session listed as `title`. This app
 *  does not read people's names, so it names the session and the role, not
 *  the person. */
export function sharedNoticeMessage(record: Pick<SessionRecord, "role">, title: string): string {
  const role = sharedRoleLabel(record);
  return `Shared with you: ${title}${role ? ` · ${role}` : ""}`;
}

/**
 * The newest `grantedAt` this client saw, per host. A read that brings a
 * shared session with a newer grant is a new share or a higher role; the
 * first read of a host only sets the mark, so opening the app does not show a
 * burst of shares that are already in the list.
 */
export class ShareArrivals {
  private readonly marks = new Map<string, number>();

  /** The shared records this read adds since the last one, newest grant first. */
  take(hostId: string, records: readonly SessionRecord[]): SessionRecord[] {
    const granted = records.filter(
      (record): record is SessionRecord & { grantedAt: number } =>
        record.grantedAt !== undefined && isSharedWithReader(record),
    );
    const newest = granted.reduce((max, record) => Math.max(max, record.grantedAt), 0);
    const mark = this.marks.get(hostId);
    this.marks.set(hostId, Math.max(mark ?? 0, newest));
    if (mark === undefined) return [];
    return granted
      .filter((record) => record.grantedAt > mark)
      .sort((left, right) => right.grantedAt - left.grantedAt);
  }

  forget(hostId: string): void {
    this.marks.delete(hostId);
  }
}
