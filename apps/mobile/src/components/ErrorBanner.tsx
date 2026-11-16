import { View } from "react-native";

import { AppText as Text } from "./AppText";
/** `detail` is the system's own error text, in small type under the message. */
export function ErrorBanner(props: { readonly message: string; readonly detail?: string | null }) {
  return (
    <View className="gap-1 rounded-2xl border border-danger-border bg-danger px-3.5 py-3">
      <Text className="font-t3-medium text-sm text-danger-foreground">{props.message}</Text>
      {props.detail ? (
        <Text selectable className="text-xs text-danger-foreground opacity-80">
          {props.detail}
        </Text>
      ) : null}
    </View>
  );
}
