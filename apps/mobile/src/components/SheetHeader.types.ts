// Adapted from T3 Code apps/mobile/src/components/ui/SheetHeader.types.ts (MIT, see UPSTREAM.md).
import type { ReactNode } from "react";

/** Cancel discards what the sheet edits; Close only dismisses it. */
type SheetDismissAction =
  | { readonly onCancel: () => void; readonly onClose?: never }
  | { readonly onClose: () => void; readonly onCancel?: never };

type SheetConfirmation = {
  readonly label: string;
  readonly onPress: () => void;
};

export type SheetHeaderProps = SheetDismissAction & {
  readonly title: string;
  readonly subtitle?: string;
  readonly accessibilityLabel?: string;
  readonly dismissDisabled?: boolean;
  readonly confirm?: SheetConfirmation;
  /**
   * "native" is the route's own header: the native bar on iOS, a full-height
   * app bar on Android. "inline" is an Android header drawn inside a partial
   * sheet. iOS always uses the native bar.
   */
  readonly presentation?: "native" | "inline";
  /** Extra Android controls before the confirmation. The iOS native bar has no custom items. */
  readonly trailing?: ReactNode;
};

export type SheetCloseButtonProps = SheetDismissAction & {
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
};
