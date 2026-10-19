import { Host, Picker, Text } from "@expo/ui/swift-ui";
import { accessibilityLabel, controlSize, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";
import { View } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { settleNativeSegment, type NativeSegmentSync } from "../lib/native-segment-sync";
import type { SegmentedControlProps } from "./SegmentedControl.types";

/**
 * iOS: UIKit's segmented control, through SwiftUI's segmented Picker (as the
 * wide iPad sidebar's tab picker). UIKit supplies the selected segment, drag
 * selection, VoiceOver traits, Dynamic Type, and reduced motion. The control
 * follows the app's light or dark appearance; its colors are the system's.
 */
export function NativeSegmentedControl<Value extends number | string>(
  props: SegmentedControlProps<Value>,
) {
  const { themeAppearance } = useAppearancePreferences();
  const [sync, setSync] = useState<NativeSegmentSync<Value>>({ chosen: null, revision: 0 });
  const settled = settleNativeSegment(sync, props.selected);
  if (settled !== sync) setSync(settled);
  return (
    <View className={props.className}>
      <Host
        key={settled.revision}
        matchContents={{ vertical: true }}
        colorScheme={themeAppearance}
        style={{ width: "100%" }}
      >
        <Picker<Value>
          selection={props.selected}
          onSelectionChange={(value) => {
            setSync((current) => ({ ...current, chosen: { value } }));
            if (value !== props.selected) props.onSelect(value);
          }}
          modifiers={[
            pickerStyle("segmented"),
            controlSize(props.size === "compact" ? "regular" : "large"),
          ]}
        >
          {props.options.map((option) => (
            <Text
              key={String(option.value)}
              modifiers={[
                tag(option.value),
                ...(option.accessibilityLabel ? [accessibilityLabel(option.accessibilityLabel)] : []),
              ]}
            >
              {option.label}
            </Text>
          ))}
        </Picker>
      </Host>
    </View>
  );
}
