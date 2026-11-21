import { ActivityIndicator, Pressable, View, type ColorValue } from "react-native";
import type { BackgroundItem } from "@solus/client-core/background-item";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill } from "../../components/ControlPill";
import { AppText as Text } from "../../components/AppText";
import { formatWorkingDuration } from "./floating-working-status";
import { useVisibleSecondClock } from "./use-visible-second-clock";

/** One row of the session's background work that the host keeps: an MCP task or a resource watch. */
export function BackgroundItemRow(props: {
  readonly item: BackgroundItem;
  readonly mayDrive: boolean;
  readonly busyActionId: string | null;
  readonly iconSubtleColor: ColorValue;
  readonly onAction: (actionId: string) => void;
}) {
  const { item } = props;
  const nowMs = useVisibleSecondClock(item.startedAt !== null);
  const stopAction = item.actions.find((action) => action.stops);
  return (
    <View className="min-h-9 flex-row items-center gap-1.5" accessibilityLabel={`${item.label}, ${item.detail}`}>
      <View className="w-5 items-center">
        {item.state === "running" ? (
          <ActivityIndicator size="small" color={props.iconSubtleColor} />
        ) : (
          <SymbolView
            name={item.state === "ended" ? "checkmark" : item.state === "stopped" ? "minus" : item.state === "waiting" ? "eye" : "exclamationmark.circle"}
            size={14}
            weight="medium"
            {...(item.state === "failed" ? { tintColorClassName: "accent-danger-foreground" } : { tintColor: props.iconSubtleColor })}
            type="monochrome"
          />
        )}
      </View>
      <Text className="shrink-0 text-sm text-foreground-muted" numberOfLines={1}>{item.label}</Text>
      <Text className="min-w-0 flex-1 text-sm text-foreground-muted opacity-70" numberOfLines={1}>{item.detail}</Text>
      {item.startedAt !== null ? (
        <Text className="text-xs text-foreground-muted opacity-60">{formatWorkingDuration(item.startedAt, nowMs)}</Text>
      ) : null}
      {item.actions.filter((action) => !action.stops).map((action) => (
        <Pressable
          key={action.id}
          accessibilityRole="button"
          accessibilityLabel={`${action.label}, ${item.label}`}
          disabled={!props.mayDrive || props.busyActionId !== null}
          onPress={() => props.onAction(action.id)}
          hitSlop={8}
          className="h-8 justify-center rounded-full px-2.5 active:opacity-70 disabled:opacity-50"
        >
          <Text className="text-sm font-t3-bold text-foreground">{props.busyActionId === action.id ? action.busyLabel : action.label}</Text>
        </Pressable>
      ))}
      {stopAction ? (
        // The composer's own Stop control, at its full 44 pt tap target.
        <ControlPill
          icon="stop.fill"
          variant="danger"
          accessibilityLabel={props.busyActionId === stopAction.id ? stopAction.busyLabel : item.stopLabel}
          disabled={!props.mayDrive || props.busyActionId !== null}
          onPress={() => props.onAction(stopAction.id)}
        />
      ) : null}
    </View>
  );
}
