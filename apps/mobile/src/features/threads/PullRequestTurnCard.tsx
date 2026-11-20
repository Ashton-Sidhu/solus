import type { SessionPullRequestLink } from "@solus/contracts/session-pull-requests";
import { WATCH_OFFER, WATCHING_NOTE, pullRequestCard, type PullRequestCard } from "@solus/client-core/pull-request-card";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { relativeTime } from "../../lib/time";
import { PR_STATE_TINT_CLASS } from "../prs/components/PrStateBadge";
import { watchRefusalMessage } from "./threadListV2";

export const STATE_TEXT_CLASS = {
  open: "text-adaptive-emerald-600-400",
  draft: "text-foreground-muted",
  merged: "text-adaptive-violet-600-400",
  closed: "text-adaptive-rose-600-400",
  missing: "text-foreground-muted",
} as const satisfies { readonly [state in NonNullable<PullRequestCard["state"]>]: string };

export const STATE_SYMBOL = {
  open: "arrow.triangle.pull",
  draft: "arrow.triangle.branch",
  merged: "arrow.triangle.merge",
  closed: "arrow.triangle.pull",
} as const satisfies { readonly [tone in keyof typeof PR_STATE_TINT_CLASS]: AppSymbolName };

/** The tone of the state's symbol; a state not known yet reads as a draft. */
export function pullRequestStateTone(card: PullRequestCard): keyof typeof STATE_SYMBOL {
  return card.state === "open" || card.state === "merged" || card.state === "closed" ? card.state : "draft";
}

/**
 * One pull request a turn linked: its card, kept fresh by PR sync, and the
 * command that turns the session's watch on it on or off. The card and each
 * row of a group card read it the same way.
 */
export function usePullRequestTurn(hostId: string, link: SessionPullRequestLink, onWatchChanged: () => Promise<void>) {
  const app = useApp();
  const pullRequest = useListened(app.pullRequests.changes, () => app.pullRequests.linkedOf(hostId, link.repository, link.number));
  useEffect(() => app.pullRequests.wantLinked(hostId, link.repository, link.number), [app, hostId, link.repository, link.number]);
  const card = pullRequestCard(link, pullRequest);
  const [isWatchBusy, setWatchBusy] = useState(false);

  const setWatch = (watching: boolean) => {
    if (isWatchBusy) return;
    void Haptics.selectionAsync();
    setWatchBusy(true);
    void app.threadList
      .setWatching(hostId, link.sessionId, link, watching)
      .then(async (outcome) => {
        await onWatchChanged();
        const refusal = watchRefusalMessage(outcome);
        if (refusal) Alert.alert("Could not watch pull request", refusal);
      })
      .catch((error: Error) => {
        Alert.alert(watching ? "Could not watch pull request" : "Could not stop watching", error.message.trim() || "The host did not answer.");
      })
      .finally(() => setWatchBusy(false));
  };

  return { card, isWatchBusy, setWatch };
}

/** `owner/repo #12 · author · 4m ago`, as desktop's card line reads. */
function metaLine(card: PullRequestCard): string {
  const age = card.openedAt === null ? null : `${relativeTime(new Date(card.openedAt).toISOString())} ago`;
  return [card.reference, card.author, age].filter((part) => part !== null).join(" · ");
}

/**
 * A pull request the session linked during a turn, as desktop and web draw it
 * (docs/plans/pr-watch.md): its state, its size, and the session's watch on
 * it. The card opens the pull request; the footer turns the watch on or off.
 */
export function PullRequestTurnCard(props: {
  readonly hostId: string;
  readonly link: SessionPullRequestLink;
  /** The reader may change the session's watches. */
  readonly canWatch: boolean;
  readonly onOpen: () => void;
  /** Read the session's links again, so the card shows the watch the host now holds. */
  readonly onWatchChanged: () => Promise<void>;
}) {
  const { card, isWatchBusy, setWatch } = usePullRequestTurn(props.hostId, props.link, props.onWatchChanged);
  const isWatching = card.watch === "watching";
  // A reader who may not change the watch still sees one that runs.
  const showsWatch = isWatching || (card.watch === "available" && props.canWatch);
  const stateTone = pullRequestStateTone(card);

  return (
    <View className="overflow-hidden rounded-[20px] border border-border bg-card-alt">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open pull request ${card.reference}: ${card.title}`}
        onPress={props.onOpen}
        className="gap-1.5 p-4 active:opacity-70"
      >
        <View className="flex-row items-center gap-1.5">
          <SymbolView
            name={STATE_SYMBOL[stateTone]}
            size={13}
            tintColorClassName={PR_STATE_TINT_CLASS[stateTone]}
          />
          {card.stateLabel && card.state ? (
            <Text className={`font-t3-medium text-xs ${STATE_TEXT_CLASS[card.state]}`}>{card.stateLabel}</Text>
          ) : null}
          <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
            {metaLine(card)}
          </Text>
        </View>
        <Text numberOfLines={2} className="font-t3-medium text-[15px] leading-5 text-foreground">
          {card.title}
        </Text>
        {card.filesLabel || card.additionsLabel ? (
          <View className="flex-row items-center gap-2">
            {card.filesLabel ? <Text className="text-xs tabular-nums text-foreground-muted">{card.filesLabel}</Text> : null}
            {card.additionsLabel && card.deletionsLabel ? (
              <Text className="text-xs tabular-nums">
                <Text className="text-adaptive-emerald-600-400">{card.additionsLabel}</Text>{" "}
                <Text className="text-adaptive-rose-600-400">{card.deletionsLabel}</Text>
              </Text>
            ) : null}
          </View>
        ) : null}
      </Pressable>
      {showsWatch ? (
        <WatchRow isWatching={isWatching} canWatch={props.canWatch} isWatchBusy={isWatchBusy} onSetWatch={setWatch} />
      ) : null}
    </View>
  );
}

/** The session's watch on the pull request: what it does, and the switch for a reader who may change it. */
function WatchRow(props: {
  readonly isWatching: boolean;
  readonly canWatch: boolean;
  readonly isWatchBusy: boolean;
  readonly onSetWatch: (watching: boolean) => void;
}) {
  const { isWatching, isWatchBusy } = props;
  return (
    <View className="flex-row items-center gap-2.5 border-t border-border px-4 py-3">
      <SymbolView name="eye" size={14} tintColorClassName={isWatching ? "accent-adaptive-emerald-600-400" : "accent-icon-muted"} />
      <Text className="min-w-0 flex-1 text-xs leading-4 text-foreground-muted">{isWatching ? WATCHING_NOTE : WATCH_OFFER}</Text>
      {props.canWatch ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isWatching ? "Stop watching this pull request" : "Watch this pull request"}
          accessibilityState={{ disabled: isWatchBusy }}
          disabled={isWatchBusy}
          onPress={() => props.onSetWatch(!isWatching)}
          className={`min-h-9 justify-center rounded-full px-3.5 active:opacity-70 ${isWatching ? "" : "bg-subtle"} ${isWatchBusy ? "opacity-50" : ""}`}
        >
          <Text className="font-t3-bold text-xs text-foreground">{isWatching ? "Turn off" : "Turn on"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
