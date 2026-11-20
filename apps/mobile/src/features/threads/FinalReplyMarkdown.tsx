import { pullRequestKey } from "@solus/client-core/reply-pull-requests";
import { View } from "react-native";

import type { ConversationStore } from "../conversation/conversation-store";
import { useOpenArtifact } from "./artifacts/use-open-artifact";
import { useSessionArtifacts } from "./artifacts/use-session-artifacts";
import { PullRequestGroupCard } from "./PullRequestGroupCard";
import { PullRequestTurnCard } from "./PullRequestTurnCard";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { useTurnReplyCards } from "./use-turn-reply-cards";

/**
 * A settled turn's final reply. A pull request the turn linked takes a card
 * after the block of the reply that mentions it, as on desktop and web
 * (`placeReplyPullRequests`); two or more in a row share one group card. A
 * reply that mentions none renders whole.
 */
export function FinalReplyMarkdown(props: {
  readonly isFinalReply: boolean;
  readonly store: ConversationStore;
  readonly replyId: string;
  readonly text: string;
  readonly promptId: string | null;
  readonly nextPromptId: string | null;
}) {
  const { hostId, run } = props.store.controller;
  const placement = useTurnReplyCards(props.store, props, props.isFinalReply ? props.replyId : null);
  const { feed } = useSessionArtifacts(hostId, run.sessionId, false);
  const { open } = useOpenArtifact(hostId, run.sessionId);
  if (!placement) return <ThreadMarkdown markdown={props.text} tone="assistant" store={props.store} />;
  return (
    <View className="gap-2">
      {placement.segments.map((segment, index) =>
        segment.kind === "text" ? (
          segment.text.trim() ? <ThreadMarkdown key={index} markdown={segment.text} tone="assistant" store={props.store} /> : null
        ) : segment.links.length === 1 ? (
          <PullRequestTurnCard
            key={pullRequestKey(segment.links[0])}
            hostId={hostId}
            link={segment.links[0]}
            canWatch={props.store.controller.mayEdit}
            onOpen={() => open({ kind: "pull-request", link: segment.links[0] })}
            onWatchChanged={() => feed.changed()}
          />
        ) : (
          <PullRequestGroupCard
            key={segment.links.map(pullRequestKey).join(" ")}
            hostId={hostId}
            links={segment.links}
            canWatch={props.store.controller.mayEdit}
            onOpen={(link) => open({ kind: "pull-request", link })}
            onWatchChanged={() => feed.changed()}
          />
        ),
      )}
    </View>
  );
}
