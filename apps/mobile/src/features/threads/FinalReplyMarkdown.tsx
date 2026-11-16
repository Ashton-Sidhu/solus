import { pullRequestKey } from "@solus/client-core/reply-pull-requests";
import { View } from "react-native";

import type { ConversationStore } from "../conversation/conversation-store";
import { useOpenArtifact } from "./artifacts/use-open-artifact";
import { useSessionArtifacts } from "./artifacts/use-session-artifacts";
import { PullRequestTurnCard } from "./PullRequestTurnCard";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { useTurnReplyCards } from "./use-turn-reply-cards";

/**
 * A settled turn's final reply. A pull request the turn linked takes a card
 * after the block of the reply that mentions it, as on desktop and web
 * (`placeReplyPullRequests`); a reply that mentions none renders whole.
 */
export function FinalReplyMarkdown(props: {
  readonly store: ConversationStore;
  readonly replyId: string;
  readonly text: string;
  readonly promptId: string | null;
  readonly nextPromptId: string | null;
}) {
  const { hostId, run } = props.store.controller;
  const placement = useTurnReplyCards(props.store, props, props.replyId);
  const { feed } = useSessionArtifacts(hostId, run.sessionId, false);
  const { open } = useOpenArtifact(hostId, run.sessionId);
  if (!placement) return <ThreadMarkdown markdown={props.text} tone="assistant" store={props.store} />;
  return (
    <View className="gap-2">
      {placement.segments.map((segment, index) =>
        segment.kind === "text" ? (
          segment.text.trim() ? <ThreadMarkdown key={index} markdown={segment.text} tone="assistant" store={props.store} /> : null
        ) : (
          <PullRequestTurnCard
            key={pullRequestKey(segment.link)}
            hostId={hostId}
            link={segment.link}
            canWatch={props.store.controller.mayEdit}
            onOpen={() => open({ kind: "pull-request", link: segment.link })}
            onWatchChanged={() => feed.changed()}
          />
        ),
      )}
    </View>
  );
}
