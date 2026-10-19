import { useState } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { AppText as Text } from "../../../components/AppText";
import { serverIconUrl } from "../integrations";

/** The catalog's icon, else the service's logo by address, else the first letter of the name. */
export function ServerIcon(props: { readonly icon?: string; readonly url: string; readonly name: string }) {
  const [failed, setFailed] = useState(false);
  const uri = props.icon ?? serverIconUrl(props.url);
  if (!failed) {
    return (
      <Image
        source={{ uri }}
        accessibilityIgnoresInvertColors
        contentFit="contain"
        onError={() => setFailed(true)}
        style={{ width: 28, height: 28, borderRadius: 6, backgroundColor: "#ffffff" }}
      />
    );
  }
  return (
    <View className="h-7 w-7 items-center justify-center rounded-md bg-subtle">
      <Text className="text-sm font-t3-bold text-foreground-muted">{props.name.trim().charAt(0).toUpperCase() || "?"}</Text>
    </View>
  );
}
