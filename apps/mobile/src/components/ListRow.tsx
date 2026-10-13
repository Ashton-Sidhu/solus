// Adapted from T3 Code apps/mobile/src/components/ListRow.tsx (MIT, see UPSTREAM.md).
import { Platform } from "react-native";
import { useResolveClassNames } from "uniwind";

import { SymbolView } from "./AppSymbol";
import { ListRowLayout, type ListRowContentProps } from "./ListRowLayout";
import { RowPressable } from "./RowPressable";

/** A navigation row owns its look; callers supply content and destination behavior. */
export function ListRow(
  props: ListRowContentProps & {
    readonly accessibilityHint?: string;
    readonly onPress: () => void;
  },
) {
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[props.label, props.description, props.detail].filter(Boolean).join(", ")}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className="bg-grouped-card"
    >
      <ListRowLayout
        icon={props.icon}
        label={props.label}
        description={props.description}
        detail={props.detail}
        disabled={props.disabled}
        accessory={
          <SymbolView
            name="chevron.right"
            size={16}
            tintColorClassName="accent-chevron"
            type="monochrome"
            weight="semibold"
          />
        }
      />
    </RowPressable>
  );
}
