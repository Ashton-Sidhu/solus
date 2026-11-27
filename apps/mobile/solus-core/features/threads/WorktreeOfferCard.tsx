import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";
import type { TranscriptItem } from "../conversation/lib/transcript-model";
import { worktreeOfferText } from "../conversation/lib/worktree-offer";
import { Button } from "../../../src/components/ui/Button";

type WorktreeOfferItem = Extract<TranscriptItem, { kind: "worktree_offer" }>;

/**
 * The agent works in a worktree this session is not bound to
 * (docs/worktree-names.md, "Agent worktrees").
 * The state is the host's, so it is the same after a reload and on desktop.
 */
export function WorktreeOfferCard(props: { readonly store: ConversationStore; readonly offer: WorktreeOfferItem }) {
  const text = worktreeOfferText(props.offer);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const decide = async (decision: "switch" | "keep") => {
    if (sending.current || !props.store.controller.mayDrive || !text.canDecide) return;
    sending.current = true;
    setBusy(true);
    try {
      await props.store.controller.decideWorktreeOffer(props.offer.offerId, decision);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <View className="mb-3 gap-1 px-1">
      <Text className="font-t3-medium text-sm text-foreground">{text.eyebrow}</Text>
      <Text className="text-xs text-foreground-muted">{text.title}</Text>
      {text.canDecide && <>
        <Text className={text.failed ? "text-sm text-warning-foreground" : "text-sm text-foreground-secondary"}>{text.detail}</Text>
        {props.store.controller.mayDrive ? (
          <View className="flex-row gap-2">
            <Button label="Switch" tone="text" disabled={busy} onPress={() => void decide("switch")} />
            <Button label="Keep current" tone="text" disabled={busy} onPress={() => void decide("keep")} />
          </View>
        ) : <Text className="text-xs text-foreground-muted">Waiting for an editor</Text>}
      </>}
    </View>
  );
}
