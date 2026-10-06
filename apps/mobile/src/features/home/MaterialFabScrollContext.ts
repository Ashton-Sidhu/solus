// Adapted from T3 Code apps/mobile/src/features/home/MaterialFabScrollContext.ts (MIT, see UPSTREAM.md).
import { createContext, useContext } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

export const MaterialFabScrollContext = createContext<
  ((event: NativeSyntheticEvent<NativeScrollEvent>) => void) | undefined
>(undefined);

export function useMaterialFabScroll() {
  return useContext(MaterialFabScrollContext);
}
