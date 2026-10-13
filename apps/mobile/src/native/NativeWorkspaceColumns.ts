// Adapted from T3 Code apps/mobile/src/native/NativeWorkspaceColumns.ios.tsx (MIT, see UPSTREAM.md).
import { Platform } from "react-native";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native-glass";

/**
 * An iPad shows the workspace in UIKit columns: the fork's split view host,
 * which needs iOS 26. T3 asks its native module whether the host exists; the
 * vendored fork always has it, so the iOS 26 check (Liquid Glass) is enough.
 * Solus has no fold metrics, so a phone always uses the compact navigator.
 */
export const NATIVE_WORKSPACE_COLUMNS_SUPPORTED =
  Platform.OS === "ios" && Platform.isPad && NATIVE_LIQUID_GLASS_SUPPORTED;
