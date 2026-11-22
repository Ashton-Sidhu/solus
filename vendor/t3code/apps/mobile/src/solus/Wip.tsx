import { useNavigation } from "@react-navigation/native";
import { AppBar } from "../components/ui/AppBar";
import type { ComponentType } from "react";
import { View } from "react-native";
import { AppText } from "../components/ui/AppText";

export function Wip() {
  const navigation = useNavigation();
  return (
    <View className="flex-1 bg-screen">
      <AppBar title="" onBack={navigation.canGoBack() ? () => navigation.goBack() : undefined} />
      <View className="flex-1 items-center justify-center">
        <AppText className="text-foreground">WIP</AppText>
      </View>
    </View>
  );
}

// Keep the URL parameters of the upstream route, including on saved deep links.
export function routeBody<Props>(
  _original: ComponentType<Props>,
  Body: ComponentType,
): ComponentType<Props> {
  return () => <Body />;
}
