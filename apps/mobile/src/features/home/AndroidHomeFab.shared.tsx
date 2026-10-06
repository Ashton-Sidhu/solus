// Adapted from T3 Code apps/mobile/src/features/home/AndroidHomeFab.shared.tsx (MIT, see UPSTREAM.md).
import type { ReactNode } from "react";

/** Other platforms render the list without Android's floating action button. */
export function AndroidHomeFabLayout(props: {
  readonly onStartNewTask: () => void;
  readonly children: ReactNode;
  readonly sidebar?: boolean;
}) {
  return <>{props.children}</>;
}
