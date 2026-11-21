import { useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { shownBackgroundRecords, type BackgroundRecord, type SessionRecordTopic } from "@solus/client-core/background-item";
import { useListened } from "../../app/app-context";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { SessionRecordsFeed } from "../conversation/session-records-feed";
import { BackgroundItemRow } from "./BackgroundItemRow";

/**
 * The thread's background records of one kind above the composer, as desktop
 * shows them under the last turn (docs/plans/mcp-first-class.md §11.5,
 * §12.5): one row each, in the work log's row style (`HostNoticeRow`): the
 * live records, and those that ended after `since`, the newest turn's start.
 * An action that gives a promise holds its row busy until the promise settles.
 */
export function ThreadBackgroundWork<T extends BackgroundRecord, Topic extends SessionRecordTopic>(props: {
  readonly feed: SessionRecordsFeed<T, Topic>;
  readonly since: number;
  readonly mayDrive: boolean;
  readonly onAction: (record: T, actionId: string) => Promise<void> | undefined;
  /** Shown under the rows, such as the question card of a row's Answer. */
  readonly children?: ReactNode;
}) {
  const iconSubtleColor = useUniwindTheme()["--color-icon-subtle"];
  const [busy, setBusy] = useState<{ readonly recordId: string; readonly actionId: string } | null>(null);
  const { feed, since } = props;
  const list = useListened(feed.changes, () => feed.list);
  const records = useMemo(() => shownBackgroundRecords(feed.kind, list, since), [feed, list, since]);
  if (!records.length) return null;
  const act = (record: T, actionId: string) => {
    const running = props.onAction(record, actionId);
    if (!running) return;
    const action = { recordId: record.id, actionId };
    setBusy(action);
    void running.catch(() => undefined).finally(() => setBusy((current) => (current === action ? null : current)));
  };
  return (
    <View className="shrink-0 gap-1 px-4 pb-2">
      {records.map((record) => (
        <BackgroundItemRow
          key={record.id}
          item={feed.kind.item(record)}
          mayDrive={props.mayDrive}
          busyActionId={busy?.recordId === record.id ? busy.actionId : null}
          iconSubtleColor={iconSubtleColor}
          onAction={(actionId) => act(record, actionId)}
        />
      ))}
      {props.children}
    </View>
  );
}
