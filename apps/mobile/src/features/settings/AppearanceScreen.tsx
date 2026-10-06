// Adapted from T3 Code apps/mobile/src/features/settings/SettingsAppearanceRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ScreenProps } from "../../navigation/routes";
import { SettingsScreen } from "./components/SettingsScreen";
import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";
import { ThemeAppearanceSection } from "./appearance/sections/ThemeAppearanceSection";

/**
 * The color scheme is the person's own setting (plans/018): with sync on, their
 * other devices use it too. Text and code sizes stay on this device, as in T3.
 * Solus mobile has no terminal, so T3's terminal section is left out.
 */
export function AppearanceScreen(_props: ScreenProps<"AppearanceSettings">) {
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title="Appearance">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <ThemeAppearanceSection />
        <TextAppearanceSection />
        <CodeAppearanceSection />
      </ScrollView>
    </SettingsScreen>
  );
}
