import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";
import type { TranscriptItem } from "../conversation/lib/transcript-model";
import { worktreeOfferText } from "../conversation/lib/worktree-offer";
import { RequestActionButton } from "./RequestActionButton";

type WorktreeOfferItem = Extract<TranscriptItem, { kind: "worktree_offer" }>;

/**
 * The agent works in a worktree this session is not bound to
 * (docs/worktree-names.md, "Agent worktrees"). It wears the approval card's chrome.
 * The state is the host's, so it is the same after a reload and on desktop.
 */
export function WorktreeOfferCard(props: { readonly store: ConversationStore; readonly offer: WorktreeOfferItem }) {
  const text = worktreeOfferText(props.offer);
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "switch" | "keep") => {
    setBusy(true);
    try {
      await props.store.controller.decideWorktreeOffer(props.offer.offerId, decision);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="mb-5 gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">{text.eyebrow}</Text>
      <Text className="font-t3-bold text-base text-foreground">{text.title}</Text>
      {text.detail ? (
        <Text className={text.failed ? "font-sans text-sm leading-normal text-danger" : "font-sans text-sm leading-normal text-foreground-secondary"}>
          {text.detail}
        </Text>
      ) : null}
      {text.canDecide ? (
        <View className="flex-row flex-wrap gap-2.5">
          <RequestActionButton label="Switch" tone="primary" disabled={busy} onPress={() => void decide("switch")} />
          <RequestActionButton label="Keep current" tone="secondary" disabled={busy} onPress={() => void decide("keep")} />
        </View>
      ) : null}
    </View>
  );
}
