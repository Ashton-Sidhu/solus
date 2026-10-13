// Adapted from T3 Code apps/mobile/src/native/v5-workspace-context.tsx (MIT, see UPSTREAM.md).
import { createContext } from "react";

// The router is shared with the other platforms; only iOS uses native columns.
export const NativeWorkspaceModeContext = createContext(false);
/** Retained tabs must not update another tab's navigation options. */
export const NativeWorkspaceTabActivityContext = createContext<{
  readonly active: boolean;
  readonly isActive: () => boolean;
} | null>(null);
/** Set in the iPad primary column: the thread the detail column shows. */
export const NativePrimaryColumnContext = createContext<{
  readonly selectedThreadKey: string | null;
} | null>(null);
