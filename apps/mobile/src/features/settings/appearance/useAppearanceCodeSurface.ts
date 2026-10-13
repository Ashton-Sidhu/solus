// Adapted from T3 Code apps/mobile/src/features/settings/appearance/useAppearanceCodeSurface.ts (MIT, see UPSTREAM.md).
// No `nativeSourceStyle`: Solus draws source files with the JavaScript surface.
import { useMemo } from "react";

import {
  resolveMobileCodeSurface,
  type ResolvedMobileCodeSurface,
} from "../../../lib/appearancePreferences";
import { createNativeReviewDiffStyle } from "../../review/nativeReviewDiffAdapter";
import { useAppearancePreferences } from "./AppearancePreferencesProvider";

export function useAppearanceCodeSurface(): {
  readonly codeSurface: ResolvedMobileCodeSurface;
  readonly codeWordBreak: boolean;
  readonly nativeReviewDiffStyle: ReturnType<typeof createNativeReviewDiffStyle>;
} {
  const { appearance } = useAppearancePreferences();
  const codeSurface = useMemo(
    () => resolveMobileCodeSurface(appearance.codeFontSize),
    [appearance.codeFontSize],
  );
  const nativeReviewDiffStyle = useMemo(
    () => createNativeReviewDiffStyle(codeSurface, appearance.codeWordBreak),
    [appearance.codeWordBreak, codeSurface],
  );

  return {
    codeSurface,
    codeWordBreak: appearance.codeWordBreak,
    nativeReviewDiffStyle,
  };
}
