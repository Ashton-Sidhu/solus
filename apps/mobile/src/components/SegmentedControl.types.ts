export interface SegmentedControlProps<Value extends number | string> {
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
    readonly accessibilityLabel?: string;
  }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  /** Compact sizing applies to the iOS control; Material buttons keep their 48dp height. */
  readonly size?: "default" | "compact";
  /** "tab" for the view switcher; filters stay plain buttons. UIKit gives iOS segments their own traits. */
  readonly role?: "tab" | "button";
  /** Layout around the control; the platform control draws its own track and selection. */
  readonly className?: string;
}
