import { useState } from "react";
import { View } from "react-native";
import { resourceWatchItem } from "@solus/client-core/resource-watch-row";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { BackgroundItemRow } from "./ThreadMcpTasks";
import type { ResourceWatchesView } from "./use-resource-watches";

/**
 * The thread's resource watches above the composer, beside the MCP task rows,
 * as desktop shows them under the last turn (docs/plans/mcp-first-class.md
 * §11.5): one row each, with the stop control while it is live.
 */
export function ThreadResourceWatches(props: { readonly view: ResourceWatchesView; readonly mayDrive: boolean }) {
  const iconSubtleColor = useUniwindTheme()["--color-icon-subtle"];
  const [busyId, setBusyId] = useState<string | null>(null);
  if (!props.view.watches.length) return null;
  return (
    <View className="shrink-0 gap-1 px-4 pb-2">
      {props.view.watches.map((watch) => (
        <BackgroundItemRow
          key={watch.id}
          item={resourceWatchItem(watch)}
          mayDrive={props.mayDrive}
          busyActionId={busyId === watch.id ? "stop" : null}
          iconSubtleColor={iconSubtleColor}
          onAction={() => {
            setBusyId(watch.id);
            void props.view.stop(watch).catch(() => undefined).finally(() => setBusyId((current) => (current === watch.id ? null : current)));
          }}
        />
      ))}
    </View>
  );
}
