// Adapted from T3 Code apps/mobile/src/components/MaterialRadioIndicator.android.tsx (MIT, see UPSTREAM.md).
import { View } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

/**
 * The Android radio mark. The enclosing radio row owns selection, touch and
 * accessibility. Solus has no system (Material You) colors, so this is always
 * T3's drawn ring in the accent text color, never the Compose radio button.
 */
export function MaterialRadioIndicator({ selected }: { readonly selected: boolean }) {
  const { themeVariables } = useAppearancePreferences();
  return (
    <View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center" }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          borderWidth: 2,
          borderColor:
            themeVariables[selected ? "--color-primary-text" : "--color-foreground-muted"],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected ? (
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: themeVariables["--color-primary-text"],
            }}
          />
        ) : null}
      </View>
    </View>
  );
}
