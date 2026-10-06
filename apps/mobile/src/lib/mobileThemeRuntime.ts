import { resolveTextScaleVariables } from "./appearancePreferences";
import {
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeMode,
} from "./mobileTheme";

// Solus has one theme in two appearances, so a theme name is the appearance.
export type MobileUniwindThemeName = MobileThemeAppearance;

export interface MobileThemeRuntimeState {
  readonly baseFontSize: number;
  readonly themeAppearance: MobileThemeAppearance;
  readonly themeMode: MobileThemeMode;
}

export type MobileThemeRuntimeOperation =
  | {
      readonly kind: "update-text-variables";
      readonly themeName: "light" | "dark" | MobileUniwindThemeName;
      readonly variables: Readonly<Record<string, number>>;
    }
  | {
      readonly kind: "set-appearance-mode";
      readonly appearance: MobileThemeAppearance;
      readonly themeMode: MobileThemeMode;
    };

const UNIWIND_THEME_NAMES: ReadonlyArray<MobileUniwindThemeName> = ["light", "dark"];

export function getMobileUniwindThemeName(
  _themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): MobileUniwindThemeName {
  return appearance;
}

/**
 * Plans imperative runtime work separately from theme selection. Palette
 * changes are handled by one root ScopedTheme render; only typography and the
 * native appearance override need imperative Uniwind/React Native updates.
 */
export function createMobileThemeRuntimeOperations(
  previous: MobileThemeRuntimeState | null,
  next: MobileThemeRuntimeState,
): ReadonlyArray<MobileThemeRuntimeOperation> {
  const operations: MobileThemeRuntimeOperation[] = [];

  if (previous === null || previous.baseFontSize !== next.baseFontSize) {
    const variables = resolveTextScaleVariables(next.baseFontSize);
    for (const themeName of UNIWIND_THEME_NAMES) {
      operations.push({ kind: "update-text-variables", themeName, variables });
    }
  }

  if (previous === null || previous.themeMode !== next.themeMode) {
    operations.push({
      kind: "set-appearance-mode",
      appearance: next.themeAppearance,
      themeMode: next.themeMode,
    });
  }

  return operations;
}
