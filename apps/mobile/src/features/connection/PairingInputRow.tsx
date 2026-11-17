// Adapted from T3 Code apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx (MIT, see UPSTREAM.md).
import { View } from "react-native";

import { AppText, AppTextInput, type AppTextInputProps } from "../../components/AppText";

export function PairingInputRow({
  label,
  ...inputProps
}: Omit<AppTextInputProps, "accessibilityLabel" | "className"> & {
  readonly label: string;
}) {
  return (
    <View collapsable={false} className="min-h-13 flex-row items-center gap-3 px-4">
      <AppText
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ includeFontPadding: false }}
        className="w-20 text-base leading-[23px] text-foreground-muted"
      >
        {label}
      </AppText>
      <AppTextInput
        {...inputProps}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-13 min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-base leading-[23px]"
        style={{ textAlignVertical: "center", includeFontPadding: false }}
      />
    </View>
  );
}
