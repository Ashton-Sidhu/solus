import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";
import type { TranscriptItem } from "../conversation/lib/transcript-model";
import { worktreeOfferText } from "../conversation/lib/worktree-offer";
import { ApprovalCardView } from "../../../src/features/threads/PendingApprovalCard";

type WorktreeOfferItem = Extract<TranscriptItem, { kind: "worktree_offer" }>;

/**
 * The agent works in a worktree this session is not bound to
 * (docs/worktree-names.md, "Agent worktrees"). It wears the approval card's chrome.
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
  if (!text.canDecide) {
    return (
      <View className="mb-3 gap-1 px-1">
        <Text className="font-t3-medium text-sm text-foreground">{text.eyebrow}</Text>
        <Text className="text-xs text-foreground-muted">{text.title}</Text>
      </View>
    );
  }
  return (
    <ApprovalCardView
      heading={text.eyebrow}
      title={text.title}
      detail={text.failed ? undefined : text.detail}
      warning={text.failed ? text.detail : undefined}
      canRespond
      mayApprove={props.store.controller.mayDrive}
      disabled={busy}
      options={[
        { id: "switch", label: "Switch", tone: "primary", respond: () => decide("switch") },
        { id: "keep", label: "Keep current", tone: "secondary", respond: () => decide("keep") },
      ]}
    />
  );
}
