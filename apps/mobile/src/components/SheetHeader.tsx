// Adapted from T3 Code apps/mobile/src/components/ui/SheetHeader.tsx (MIT, see UPSTREAM.md).
import { useUniwindTheme } from "../lib/useUniwindTheme";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../native/StackHeader";
import type { SheetHeaderProps } from "./SheetHeader.types";

/**
 * The header of a sheet on iOS, as T3 Code #21978: the native bar with an X
 * that dismisses on the left and a prominent checkmark that confirms on the
 * right. The route declares the bar's style (SHEET_GLASS_HEADER_OPTIONS).
 */
export function SheetHeader(props: SheetHeaderProps) {
  const colors = useUniwindTheme();
  const confirmation = props.confirm;

  // Toolbar children are parsed as native items, so keep the actual Button
  // elements here instead of hiding them behind another component.
  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: props.title,
          headerBackVisible: false,
          unstable_headerSubtitle: props.subtitle,
        }}
      />
      <NativeHeaderToolbar placement="left">
        <NativeHeaderToolbar.Button
          icon="xmark"
          accessibilityLabel={props.accessibilityLabel ?? (props.onCancel ? "Cancel" : "Close")}
          onPress={props.onCancel ?? props.onClose}
          disabled={props.dismissDisabled}
        />
      </NativeHeaderToolbar>
      {confirmation ? (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Button
            icon="checkmark"
            variant="prominent"
            tintColor={colors["--color-prominent-action"]}
            accessibilityLabel={confirmation.label}
            onPress={confirmation.onPress}
          />
        </NativeHeaderToolbar>
      ) : null}
    </>
  );
}
