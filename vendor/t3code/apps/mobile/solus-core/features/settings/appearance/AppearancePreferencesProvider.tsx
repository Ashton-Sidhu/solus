import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";
import { ScopedTheme, ScopedVariables, Uniwind } from "uniwind";

import { useApp, useListened } from "../../../app/app-context";
import {
  resolveAppearance,
  resolveAppearancePreferences,
  type AppearancePreferences,
  type ResolvedAppearance,
} from "../../../lib/appearancePreferences";
import {
  DEFAULT_MOBILE_THEME_ID,
  getMobileThemeVariables,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeMode,
  type MobileThemeVariables,
} from "../../../lib/mobileTheme";
import {
  createMobileThemeRuntimeOperations,
  type MobileThemeRuntimeState,
} from "../../../lib/mobileThemeRuntime";

/**
 * The Solus side of T3 Code's appearance provider
 * (`features/settings/appearance/AppearancePreferencesProvider.tsx`, MIT, see
 * UPSTREAM.md). T3's components read the same context value; Solus supplies it:
 *
 * - Light or dark is the person's `themeMode` (`app.appearance`, plans/018).
 * - The palette is Solus's, in T3's tokens (`mobileTheme.ts`). There is one
 *   theme, so the theme choosers T3 offers have nothing to choose.
 * - Text sizes stay on this device, as T3 keeps them.
 */

const TEXT_SIZES_KEY = "solus.mobile.textSizes";

interface AppearancePreferencesContextValue {
  /** Effective values with base-size derivation applied. Use this for rendering. */
  readonly appearance: ResolvedAppearance;
  readonly themeId: MobileThemeId;
  readonly themeIds: Readonly<Record<MobileThemeAppearance, MobileThemeId>>;
  readonly themeMode: MobileThemeMode;
  readonly themeAppearance: MobileThemeAppearance;
  readonly systemColorsAvailable: boolean;
  readonly systemColorsActive: boolean;
  readonly themeVariables: MobileThemeVariables;
  readonly themeVariablesByAppearance: Readonly<
    Record<MobileThemeAppearance, MobileThemeVariables>
  >;
  readonly isReady: boolean;
  readonly setThemeMode: (value: MobileThemeMode) => void;
  readonly setBaseFontSize: (value: number) => void;
  /** Pass null to clear the override and follow the base font size. */
  readonly setTerminalFontSize: (value: number | null) => void;
  /** Pass null to clear the override and follow the base font size. */
  readonly setCodeFontSize: (value: number | null) => void;
  readonly setCodeWordBreak: (value: boolean) => void;
}

const AppearancePreferencesContext = createContext<AppearancePreferencesContextValue | null>(null);

const THEME_VARIABLES_BY_APPEARANCE = {
  light: getMobileThemeVariables("light"),
  dark: getMobileThemeVariables("dark"),
} as const;

function readTextSizes(raw: string | null): AppearancePreferences {
  if (!raw) return resolveAppearancePreferences(null);
  try {
    return resolveAppearancePreferences(JSON.parse(raw));
  } catch {
    return resolveAppearancePreferences(null);
  }
}

export function AppearancePreferencesProvider(props: { readonly children: ReactNode }) {
  const app = useApp();
  const themeMode = useListened(app.appearance.changes, app.appearance.current);
  const systemColorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const themeAppearance: MobileThemeAppearance = themeMode === "system" ? systemColorScheme : themeMode;
  const [preferences, setPreferences] = useState(() =>
    readTextSizes(app.platform.storage.getItem(TEXT_SIZES_KEY)),
  );
  const { baseFontSize, codeFontSize, codeWordBreak, terminalFontSize } = preferences;
  const appearance = useMemo(
    () => resolveAppearance({ baseFontSize, codeFontSize, codeWordBreak, terminalFontSize }),
    [baseFontSize, codeFontSize, codeWordBreak, terminalFontSize],
  );
  const themeVariables = THEME_VARIABLES_BY_APPEARANCE[themeAppearance];

  // Typography scaling is imperative in uniwind; the native appearance itself
  // is applied by `app.appearance`, so only text variables are written here.
  const appliedRef = useRef<MobileThemeRuntimeState | null>(null);
  useLayoutEffect(() => {
    const next: MobileThemeRuntimeState = { baseFontSize, themeAppearance, themeMode };
    for (const operation of createMobileThemeRuntimeOperations(appliedRef.current, next)) {
      if (operation.kind === "update-text-variables") {
        Uniwind.updateCSSVariables(operation.themeName, operation.variables);
      }
    }
    appliedRef.current = next;
  }, [baseFontSize, themeAppearance, themeMode]);

  const update = useCallback(
    (patch: Partial<AppearancePreferences>) => {
      setPreferences((current) => {
        const next = { ...current, ...patch };
        app.platform.storage.setItem(TEXT_SIZES_KEY, JSON.stringify(next));
        return next;
      });
    },
    [app],
  );

  const value = useMemo(
    (): AppearancePreferencesContextValue => ({
      appearance,
      themeId: DEFAULT_MOBILE_THEME_ID,
      themeIds: { light: DEFAULT_MOBILE_THEME_ID, dark: DEFAULT_MOBILE_THEME_ID },
      themeMode,
      themeAppearance,
      systemColorsAvailable: false,
      systemColorsActive: false,
      themeVariables,
      themeVariablesByAppearance: THEME_VARIABLES_BY_APPEARANCE,
      isReady: true,
      setThemeMode: (mode) => app.appearance.set(mode),
      setBaseFontSize: (size) => update({ baseFontSize: size }),
      setTerminalFontSize: (size) => update({ terminalFontSize: size }),
      setCodeFontSize: (size) => update({ codeFontSize: size }),
      setCodeWordBreak: (wordBreak) => update({ codeWordBreak: wordBreak }),
    }),
    [app, appearance, themeAppearance, themeMode, themeVariables, update],
  );

  return (
    <AppearancePreferencesContext.Provider value={value}>
      <ScopedTheme theme={themeAppearance}>
        <ScopedVariables variables={themeVariables}>{props.children}</ScopedVariables>
      </ScopedTheme>
    </AppearancePreferencesContext.Provider>
  );
}

export function useAppearancePreferences(): AppearancePreferencesContextValue {
  const context = use(AppearancePreferencesContext);
  if (!context) {
    throw new Error("useAppearancePreferences must be used within AppearancePreferencesProvider");
  }
  return context;
}
