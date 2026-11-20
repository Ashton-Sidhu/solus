import type { SessionPullRequestLink } from "@solus/contracts/session-pull-requests";
import { WATCH_OFFER, WATCHING_NOTE, pullRequestCard, pullRequestGroupSummary } from "@solus/client-core/pull-request-card";
import { pullRequestKey } from "@solus/client-core/reply-pull-requests";
import { Pressable, View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { PR_STATE_TINT_CLASS } from "../prs/components/PrStateBadge";
import { STATE_SYMBOL, STATE_TEXT_CLASS, pullRequestStateTone, usePullRequestTurn } from "./PullRequestTurnCard";

/**
 * Two or more pull requests a final reply links in a row, as desktop and web
 * draw them (`ReplyPullRequestGroup`): one card that counts them and their
 * states, and one row per pull request with its own watch.
 */
export function PullRequestGroupCard(props: {
  readonly hostId: string;
  readonly links: readonly SessionPullRequestLink[];
  /** The reader may change the session's watches. */
  readonly canWatch: boolean;
  readonly onOpen: (link: SessionPullRequestLink) => void;
  /** Read the session's links again, so each row shows the watch the host now holds. */
  readonly onWatchChanged: () => Promise<void>;
}) {
  const { hostId, links } = props;
  const app = useApp();
  // A string, so the snapshot stays equal until a state really changes. The
  // rows keep PR sync reading each pull request.
  const status = useListened(app.pullRequests.changes, () =>
    pullRequestGroupSummary(links.map((link) => pullRequestCard(link, app.pullRequests.linkedOf(hostId, link.repository, link.number)))).status,
  );
  const title = `${links.length} pull requests`;

  return (
    <View className="overflow-hidden rounded-[20px] border border-border bg-card-alt">
      <View accessibilityRole="header" accessibilityLabel={status ? `${title}, ${status}` : title} className="flex-row items-center gap-2 px-4 pt-3.5 pb-2.5">
        <SymbolView name="arrow.triangle.pull" size={13} tintColorClassName="accent-icon-muted" />
        <Text className="font-t3-medium text-[15px] text-foreground">{title}</Text>
        {status ? (
          <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
            {status}
          </Text>
        ) : null}
      </View>
      {links.map((link) => (
        <PullRequestGroupRow
          key={pullRequestKey(link)}
          hostId={hostId}
          link={link}
          canWatch={props.canWatch}
          onOpen={() => props.onOpen(link)}
          onWatchChanged={props.onWatchChanged}
        />
      ))}
    </View>
  );
}

/** One pull request of the group: the row opens it, and the eye at its end is its watch. */
function PullRequestGroupRow(props: {
  readonly hostId: string;
  readonly link: SessionPullRequestLink;
  readonly canWatch: boolean;
  readonly onOpen: () => void;
  readonly onWatchChanged: () => Promise<void>;
}) {
  const { card, isWatchBusy, setWatch } = usePullRequestTurn(props.hostId, props.link, props.onWatchChanged);
  const isWatching = card.watch === "watching";
  const stateTone = pullRequestStateTone(card);
  // `card.reference` is `repo #12`.
  const numberLabel = `#${props.link.number}`;

  return (
    <View className="flex-row items-center border-t border-border pr-1.5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open pull request ${card.reference}: ${card.title}`}
        onPress={props.onOpen}
        className="min-w-0 flex-1 flex-row items-center gap-2.5 py-2.5 pl-4 active:opacity-70"
      >
        <SymbolView name={STATE_SYMBOL[stateTone]} size={13} tintColorClassName={PR_STATE_TINT_CLASS[stateTone]} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="font-t3-medium text-sm text-foreground">
            {card.title}
          </Text>
          <View className="flex-row items-center gap-1.5">
            {card.stateLabel && card.state ? (
              <Text className={`text-xs ${STATE_TEXT_CLASS[card.state]}`}>{card.stateLabel.toLowerCase()}</Text>
            ) : null}
            {/* A long repository name is what gets cut; the number stays whole. */}
            <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">
              {card.reference.slice(0, -numberLabel.length).trimEnd()}
            </Text>
            <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{numberLabel}</Text>
          </View>
        </View>
        {card.additionsLabel && card.deletionsLabel ? (
          <Text className="text-xs tabular-nums">
            <Text className="text-adaptive-emerald-600-400">{card.additionsLabel}</Text>{" "}
            <Text className="text-adaptive-rose-600-400">{card.deletionsLabel}</Text>
          </Text>
        ) : null}
      </Pressable>
      {/* Every row keeps the slot, so the sizes line up down the group. A
          merged or closed pull request has nothing to watch. */}
      {card.watch !== "unavailable" && props.canWatch ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel={`Watch ${card.reference}`}
          accessibilityHint={isWatching ? WATCHING_NOTE : WATCH_OFFER}
          accessibilityState={{ checked: isWatching, disabled: isWatchBusy }}
          disabled={isWatchBusy}
          onPress={() => setWatch(!isWatching)}
          className={`size-10 items-center justify-center rounded-full active:opacity-70 ${isWatchBusy ? "opacity-50" : ""}`}
        >
          <SymbolView
            name={isWatching ? "eye" : "eye.slash"}
            size={15}
            tintColorClassName={isWatching ? "accent-adaptive-emerald-600-400" : "accent-icon-muted"}
          />
        </Pressable>
      ) : isWatching ? (
        <View accessible accessibilityLabel={WATCHING_NOTE} className="size-10 items-center justify-center">
          <SymbolView name="eye" size={15} tintColorClassName="accent-adaptive-emerald-600-400" />
        </View>
      ) : (
        <View className="size-10" />
      )}
    </View>
  );
}
