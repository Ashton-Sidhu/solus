import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { MobileThemeVariables } from "./mobileTheme";

/**
 * Complete JS palette for native and third-party APIs that cannot consume a
 * Uniwind className (React Navigation, native editors, Markdown, SVG gradients,
 * Reanimated worklets), as T3 Code's `useUniwindTheme` (MIT, see UPSTREAM.md).
 * Ordinary React Native rendering uses className.
 */
export function useUniwindTheme(): MobileThemeVariables {
  return useAppearancePreferences().themeVariables;
}
