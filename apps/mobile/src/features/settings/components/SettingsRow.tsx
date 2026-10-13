// Adapted from T3 Code apps/mobile/src/features/settings/components/SettingsRow.tsx (MIT, see UPSTREAM.md).
import type { ComponentProps } from "react";
import { Platform } from "react-native";

import { ListRow } from "../../../components/ListRow";

/**
 * T3's settings row. Solus has one stack navigator, so the row takes an
 * `onPress` instead of T3's settings-sheet targets.
 */
export function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof ListRow>["icon"];
  readonly label: string;
  readonly value?: string;
  readonly valuePosition?: "below" | "trailing";
  readonly accessibilityHint?: string;
  readonly onPress: () => void;
}) {
  const valueBelow =
    props.valuePosition === "below" ||
    (props.valuePosition === undefined && Platform.OS === "android");
  return (
    <ListRow
      icon={props.icon}
      label={props.label}
      description={valueBelow ? props.value : undefined}
      detail={valueBelow ? undefined : props.value}
      disabled={props.disabled}
      accessibilityHint={props.accessibilityHint}
      onPress={props.onPress}
    />
  );
}
