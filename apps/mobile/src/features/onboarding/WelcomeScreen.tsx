// Adapted from T3 Code apps/mobile/src/features/home/HomeScreen.tsx (MIT, see UPSTREAM.md).
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ScreenProps } from "../../navigation/routes";
import { ConnectOptionCard } from "../connection/ConnectOptionCard";

/**
 * No saved host and no account: the same connect page a new task shows when
 * no host can run it (docs/plans/draft-connect-host.md), with the two ways in.
 * A Solus Cloud account is optional.
 */
export function WelcomeScreen({ navigation }: ScreenProps<"Welcome">) {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-screen android:bg-header">
      <View
        className={cn(
          "flex-1 items-center justify-center bg-screen px-5",
          Platform.OS === "android" && "overflow-hidden rounded-t-[28px]",
        )}
        style={{ paddingBottom: Math.max(insets.bottom, 24), paddingTop: insets.top }}
      >
        <View className="w-full max-w-[520px]">
          <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
            Connect a host to start
          </Text>
          <Text className="mt-2 mb-6 text-center text-sm text-foreground-muted">
            A host is a machine that has your code. Solus runs agents there and reconnects on its own.
          </Text>
          <View className="gap-2">
            <ConnectOptionCard
              icon="link"
              title="Pair a machine"
              detail="Scan the code in Settings → Hosts → Access on your computer, or enter its address."
              onPress={() => navigation.navigate("PairHost")}
            />
            <ConnectOptionCard
              icon="cloud"
              title="Solus Cloud"
              detail="Sign in to see the hosts linked to your account."
              onPress={() => navigation.navigate("CloudSignIn")}
            />
          </View>
        </View>
      </View>
    </View>
  );
}
