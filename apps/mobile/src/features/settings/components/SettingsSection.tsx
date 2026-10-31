// Adapted from T3 Code apps/mobile/src/features/settings/components/SettingsSection.tsx (MIT, see UPSTREAM.md).
import type { ComponentProps } from "react";
import { View } from "react-native";
import { ListSection } from "../../../components/ListSection";

export function SettingsSection(props: ComponentProps<typeof ListSection>) {
  return (
    <View className="gap-6">
      <ListSection {...props} />
      <View accessible={false} className="h-px w-9/10 self-center bg-border" />
    </View>
  );
}
