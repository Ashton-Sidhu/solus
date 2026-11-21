import { useMemo, useState } from "react";
import { FlatList } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { PickRow, PickSheet } from "../../components/PickSheet";
import type { SolusThreadShell } from "./thread-directory";
import { sessionReferenceCandidates, sessionReferenceTitle } from "./session-reference";

/** The composer's "Reference Session…" sheet: a session on this host, chosen
 *  by name, goes into the draft as a `session://ref` token (desktop drags it
 *  from the sidebar). */
export function SessionReferencePicker(props: {
  readonly hostId: string;
  readonly currentSessionId: string;
  readonly onPick: (thread: SolusThreadShell) => void;
  readonly onClose: () => void;
}) {
  const app = useApp();
  const [query, setQuery] = useState("");
  const threads = useListened(app.threads.changes, app.threads.threads);
  const unlisted = useListened(app.threads.changes, app.threads.unlistedThreads);
  const candidates = useMemo(
    () => sessionReferenceCandidates({ threads: [...threads, ...unlisted], hostId: props.hostId, currentSessionId: props.currentSessionId, query }),
    [props.currentSessionId, props.hostId, query, threads, unlisted],
  );
  return (
    <PickSheet title="Reference Session" search={{ label: "Search sessions", query, autoFocus: true, onChange: setQuery }} onClose={props.onClose}>
      <FlatList
        data={candidates}
        keyExtractor={(thread) => thread.key}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text className="px-5 py-6 text-sm text-foreground-muted">No matching sessions.</Text>}
        renderItem={({ item: thread }) => (
          <PickRow onPress={() => props.onPick(thread)}>
            <Text numberOfLines={1} className="text-sm font-t3-medium text-primary-text">{sessionReferenceTitle(thread)}</Text>
            <Text numberOfLines={1} className="text-xs text-foreground-tertiary">{thread.record.branch ?? thread.record.projectPath} · {thread.record.provider}</Text>
          </PickRow>
        )}
      />
    </PickSheet>
  );
}
