import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";

/**
 * The iOS thread header's title view: the session title, then the project's
 * favicon before the "project · host" line. UIKit's own title and subtitle
 * take only strings, so a header with a mark draws both itself. `maxWidth`
 * keeps the title clear of the native bar buttons, as `WorkspaceConnectionTitle`
 * does; both lines truncate at its end.
 */
export function ThreadHeaderTitle(props: {
  readonly title: string;
  /** Shown under the title; without one the mark sits before the title. */
  readonly subtitle?: string;
  readonly mark: ReactNode;
  readonly maxWidth: number;
  /** The Liquid Glass header's heavier title weight. */
  readonly heavy: boolean;
}) {
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={props.subtitle ? `${props.title}, ${props.subtitle}` : props.title}
      style={{ alignItems: "center", maxWidth: props.maxWidth }}
    >
      <View className="max-w-full flex-row items-center gap-1.5">
        {props.subtitle ? null : props.mark}
        <Text
          numberOfLines={1}
          className="flex-shrink text-foreground"
          style={{ fontSize: 17, fontWeight: props.heavy ? "800" : "600" }}
        >
          {props.title}
        </Text>
      </View>
      {props.subtitle ? (
        <View className="max-w-full flex-row items-center gap-1">
          {props.mark}
          <Text
            numberOfLines={1}
            className="flex-shrink text-[12px] font-t3-medium text-foreground-muted"
          >
            {props.subtitle}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
