import { useState, type ReactNode } from "react";
import { View } from "react-native";
import type { BackgroundKind, BackgroundRecord } from "@solus/client-core/background-item";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { BackgroundItemRow } from "./BackgroundItemRow";

/**
 * The thread's background records of one kind above the composer, as desktop
 * shows them under the last turn (docs/plans/mcp-first-class.md §11.5,
 * §12.5): one row each, in the work log's row style (`HostNoticeRow`). An
 * action that gives a promise holds its row busy until the promise settles.
 */
export function ThreadBackgroundWork<T extends BackgroundRecord>(props: {
  readonly kind: BackgroundKind<T>;
  readonly records: readonly T[];
  readonly mayDrive: boolean;
  readonly onAction: (record: T, actionId: string) => Promise<void> | undefined;
  /** Shown under the rows, such as the question card of a row's Answer. */
  readonly children?: ReactNode;
}) {
  const iconSubtleColor = useUniwindTheme()["--color-icon-subtle"];
  const [busy, setBusy] = useState<{ readonly recordId: string; readonly actionId: string } | null>(null);
  if (!props.records.length) return null;
  const act = (record: T, actionId: string) => {
    const running = props.onAction(record, actionId);
    if (!running) return;
    const action = { recordId: record.id, actionId };
    setBusy(action);
    void running.catch(() => undefined).finally(() => setBusy((current) => (current === action ? null : current)));
  };
  return (
    <View className="shrink-0 gap-1 px-4 pb-2">
      {props.records.map((record) => (
        <BackgroundItemRow
          key={record.id}
          item={props.kind.item(record)}
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
