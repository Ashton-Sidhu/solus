import { Platform } from "react-native";
import { MaterialSegmentedControl } from "./MaterialSegmentedControl";
import { NativeSegmentedControl } from "./NativeSegmentedControl";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

/** The platform's own segmented control: Material segmented buttons on Android, UIKit's on iOS. */
export function SegmentedControl<Value extends number | string>(
  props: SegmentedControlProps<Value>,
) {
  return Platform.OS === "android" ? (
    <MaterialSegmentedControl {...props} />
  ) : (
    <NativeSegmentedControl {...props} />
  );
}
