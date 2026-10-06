// Adapted from T3 Code apps/mobile/src/features/threads/UsageLimitRecoveryCard.tsx (MIT, see UPSTREAM.md).
import type { RateLimitInfo } from "@solus/contracts/types";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";

/**
 * The agent hit its usage limit. Solus holds the turn on the host and asks
 * what to do: wait for the reset, send now anyway, or stop.
 */
export function UsageLimitRecoveryCard(props: {
  readonly store: ConversationStore;
  readonly rateLimit: RateLimitInfo;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resetsAt = props.rateLimit.resetsAt;
  async function decide(action: "send_now" | "stop" | "wait") {
    setPending(true);
    setError(null);
    try {
      await props.store.controller.rateLimitDecision(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    } finally {
      setPending(false);
    }
  }
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-background p-3">
      <Text className="text-sm text-warning-foreground">
        {resetsAt
          ? `Usage limit resets ${new Date(resetsAt * 1000).toLocaleString()}.`
          : "The provider did not report a reset time. Retry manually when your limit is available."}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => void decide("wait")}
          className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
        >
          <Text className="text-sm text-foreground">Resume at reset</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => void decide("send_now")}
          className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
        >
          <Text className="text-sm text-foreground">Send now</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => void decide("stop")}
          className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
        >
          <Text className="text-sm text-danger-foreground">Stop</Text>
        </Pressable>
      </View>
      {error ? <Text className="text-xs text-danger-foreground">{error}</Text> : null}
    </View>
  );
}
