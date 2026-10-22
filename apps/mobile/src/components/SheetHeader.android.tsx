// Adapted from T3 Code apps/mobile/src/components/ui/SheetHeader.android.tsx (MIT, see UPSTREAM.md).
import { View } from "react-native";

import { AndroidScreenHeader } from "./AndroidScreenHeader";
import { MaterialButton } from "./MaterialButton";
import { MaterialIconButton } from "./MaterialIconButton";
import type { SheetCloseButtonProps, SheetHeaderProps } from "./SheetHeader.types";

function SheetCloseButton(props: SheetCloseButtonProps) {
  return (
    <MaterialIconButton
      icon="xmark"
      accessibilityLabel={props.accessibilityLabel ?? (props.onCancel ? "Cancel" : "Close")}
      disabled={props.disabled}
      tintColorClassName="accent-header-foreground"
      onPress={props.onCancel ?? props.onClose}
    />
  );
}

/** The header of a sheet on Android, as T3 Code #21978: an X, the title, and a labeled confirmation. */
export function SheetHeader(props: SheetHeaderProps) {
  const confirmation = props.confirm;
  const trailing =
    props.trailing || confirmation ? (
      <View className="flex-row items-center gap-2">
        {props.trailing}
        {confirmation ? (
          <MaterialButton label={confirmation.label} tone="text" onPress={confirmation.onPress} />
        ) : null}
      </View>
    ) : undefined;

  return (
    <AndroidScreenHeader
      embedded={props.presentation === "inline"}
      title={props.title}
      subtitle={props.subtitle}
      leading={
        <SheetCloseButton
          {...(props.onCancel ? { onCancel: props.onCancel } : { onClose: props.onClose })}
          accessibilityLabel={props.accessibilityLabel}
          disabled={props.dismissDisabled}
        />
      }
      trailing={trailing}
      hideBottomBorder
    />
  );
}
