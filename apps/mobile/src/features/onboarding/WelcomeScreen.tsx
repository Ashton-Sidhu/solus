// Adapted from T3 Code apps/mobile/src/features/home/HomeScreen.tsx (MIT, see UPSTREAM.md).
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { MaterialFloatingActionButton } from "../../components/MaterialFloatingActionButton";
import { cn } from "../../lib/cn";
import type { ScreenProps } from "../../navigation/routes";

/**
 * No saved host and no account: T3's empty home with the two ways in. A Solus
 * Cloud account is optional.
 */
export function WelcomeScreen({ navigation }: ScreenProps<"Welcome">) {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-screen android:bg-header">
      <View
        className={cn(
          "flex-1 items-center justify-center bg-screen px-8",
          Platform.OS === "android" && "overflow-hidden rounded-t-[28px]",
        )}
        style={{ paddingBottom: Math.max(insets.bottom, 24), paddingTop: insets.top }}
      >
        <View className="w-full max-w-[430px]">
          <EmptyState
            title="No hosts connected"
            detail="Add a host to load projects and start coding sessions."
            action={
              <View className="items-center gap-3">
                {Platform.OS === "android" ? (
                  <MaterialFloatingActionButton
                    label="Add host"
                    icon="plus"
                    variant="extended"
                    tone="primary"
                    onPress={() => navigation.navigate("PairHost")}
                  />
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityHint="Pair with a Solus host by its code or address"
                    className="rounded-full bg-primary px-5 py-3 active:opacity-70"
                    onPress={() => navigation.navigate("PairHost")}
                  >
                    <Text className="text-sm font-t3-bold text-primary-foreground">Add host</Text>
                  </Pressable>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityHint="Use the hosts your Solus account can reach"
                  hitSlop={8}
                  className="items-center py-1 active:opacity-70"
                  onPress={() => navigation.navigate("CloudSignIn")}
                >
                  <Text className="text-sm font-t3-medium text-foreground-muted">
                    Sign in to Solus Cloud
                  </Text>
                </Pressable>
              </View>
            }
            variant="plain"
          />
        </View>
      </View>
    </View>
  );
}
