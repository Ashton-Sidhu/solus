// Adapted from T3 Code apps/mobile/src/features/settings/components/SettingsSwitchRow.tsx (MIT, see UPSTREAM.md).
import type { ComponentProps } from "react";

import { ListToggleRow } from "../../../components/ListToggleRow";

export function SettingsSwitchRow({
  subtitle,
  ...props
}: Omit<ComponentProps<typeof ListToggleRow>, "description"> & {
  readonly subtitle?: string;
}) {
  return <ListToggleRow {...props} description={subtitle} />;
}
