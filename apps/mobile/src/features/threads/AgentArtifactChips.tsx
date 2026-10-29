import type { SessionArtifact, SessionArtifacts } from "@solus/contracts/session-artifacts";
import {
  cardChips,
  chipTotals,
  sessionArtifactItems,
  type ArtifactChipTone,
  type PullRequestChipState,
} from "@solus/client-core/session-artifact-chips";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { RootStackParamList } from "../../navigation/routes";
import { artifactKey } from "./artifacts/session-artifacts";
import { useOpenArtifact } from "./artifacts/use-open-artifact";
import { sessionArtifactsFeed, useSessionArtifacts } from "./artifacts/use-session-artifacts";

// The type tints of desktop's ArtifactChip.svelte. A pull request's chip is
// plain; its icon takes the colour of its state.
const CHIP_CLASS = {
  "pull-request": "border border-border bg-card",
  written: "bg-artifact-written-fill",
  drawn: "bg-artifact-drawn-fill",
  file: "bg-artifact-file-fill",
  image: "bg-artifact-image-fill",
  automation: "bg-artifact-automation-fill",
} as const satisfies { readonly [tone in ArtifactChipTone]: string };

const TEXT_CLASS = {
  "pull-request": "text-foreground",
  written: "text-artifact-written",
  drawn: "text-artifact-drawn",
  file: "text-artifact-file",
  image: "text-artifact-image",
  automation: "text-artifact-automation",
} as const satisfies { readonly [tone in ArtifactChipTone]: string };

const ICON_TINT = {
  "pull-request": "accent-foreground-muted",
  written: "accent-artifact-written",
  drawn: "accent-artifact-drawn",
  file: "accent-artifact-file",
  image: "accent-artifact-image",
  automation: "accent-artifact-automation",
} as const satisfies { readonly [tone in ArtifactChipTone]: string };

const PR_STATE_TINT = {
  open: "accent-adaptive-emerald-600-400",
  draft: "accent-foreground-muted",
  merged: "accent-adaptive-violet-600-400",
  closed: "accent-adaptive-rose-600-400",
  missing: "accent-foreground-muted",
} as const satisfies { readonly [state in PullRequestChipState]: string };

const TONE_ICON = {
  "pull-request": "arrow.triangle.pull",
  written: "doc.text",
  drawn: "point.3.connected.trianglepath.dotted",
  file: "doc",
  image: "photo",
  automation: "clock",
} as const satisfies { readonly [tone in ArtifactChipTone]: AppSymbolName };

type Navigation = NativeStackNavigationProp<RootStackParamList>;

function iconFor(tone: ArtifactChipTone, state: PullRequestChipState | null): AppSymbolName {
  if (state === "merged") return "arrow.triangle.merge";
  if (state === "draft") return "arrow.triangle.branch";
  return TONE_ICON[tone];
}

function Chip(props: {
  readonly tone: ArtifactChipTone;
  readonly label: string;
  readonly note: string | null;
  readonly pullRequestState: PullRequestChipState | null;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.note ? `${props.label}, ${props.note}` : props.label}
      onPress={() => {
        void Haptics.selectionAsync();
        props.onPress();
      }}
      className={cn("h-7 max-w-full flex-row items-center gap-1 rounded-full pl-2 pr-2.5 active:opacity-70", CHIP_CLASS[props.tone])}
    >
      <SymbolView
        name={iconFor(props.tone, props.pullRequestState)}
        size={11}
        tintColorClassName={props.pullRequestState ? PR_STATE_TINT[props.pullRequestState] : ICON_TINT[props.tone]}
      />
      <Text numberOfLines={1} className={cn("min-w-0 shrink text-xs font-t3-medium", TEXT_CLASS[props.tone])}>
        {props.label}
      </Text>
      {props.note ? <Text className="shrink-0 text-xs text-foreground-muted">{props.note}</Text> : null}
    </Pressable>
  );
}

/**
 * What one session linked, under its row: a chip per item, newest first, as
 * on desktop and web. The row wraps and stops at a few chips; `+N`, and any
 * item the phone cannot open (a work or an automation), opens the session's
 * Artifacts screen.
 */
function AgentArtifactChips(props: { readonly hostId: string; readonly sessionId: string; readonly items: readonly SessionArtifact[] }) {
  const navigation = useNavigation<Navigation>();
  const { open, opens } = useOpenArtifact(props.hostId, props.sessionId);
  const { shown, hiddenCount } = cardChips(props.items);
  const openAll = () => navigation.push("ThreadArtifacts", { hostId: props.hostId, sessionId: props.sessionId });
  return (
    <View className="min-w-0 flex-row flex-wrap gap-1.5">
      {shown.map((chip) => (
        <Chip
          key={artifactKey(chip.artifact)}
          tone={chip.tone}
          label={chip.label}
          note={chip.note}
          pullRequestState={chip.pullRequestState}
          onPress={() => (opens(chip.artifact) ? open(chip.artifact) : openAll())}
        />
      ))}
      {hiddenCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Show all ${props.items.length} linked items`}
          onPress={openAll}
          className="h-7 flex-row items-center rounded-full bg-subtle px-2.5 active:opacity-70"
        >
          <Text className="text-xs font-t3-medium tabular-nums text-foreground-muted">+{hiddenCount}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The chips' frame. The space around the chips opens the session, as the row
 * above does, so the whole card is one target; a chip opens its item. Hidden
 * from accessibility: the row above is the control that opens the session.
 */
function ChipsFrame(props: { readonly className: string; readonly onOpenSession: () => void; readonly children: ReactNode }) {
  return (
    <Pressable accessible={false} importantForAccessibility="no" onPress={props.onOpenSession} className={cn(props.className, "active:bg-subtle")}>
      {props.children}
    </Pressable>
  );
}

/**
 * The list of the thread whose feed shows the agents. Its screen reads and
 * follows it (`ThreadRouteScreen`); this only reads the shared feed, so every
 * agent group of the thread costs no read of its own.
 */
export function useCallerArtifacts(hostId: string, sessionId: string): SessionArtifacts | null {
  const feed = sessionArtifactsFeed(useApp(), hostId, sessionId);
  const snapshot = useListened(feed.changes, () => feed.snapshot);
  return snapshot.state.kind === "ready" ? snapshot.state.artifacts : null;
}

/**
 * One agent's chips. They come from the caller's list, which holds a group for
 * each session the caller started; a session it did not start is read on its own.
 */
export function AgentRowArtifacts(props: {
  readonly hostId: string;
  readonly callerSessionId: string;
  readonly callerArtifacts: SessionArtifacts | null;
  readonly sessionId: string;
  readonly className: string;
  readonly onOpenSession: () => void;
}) {
  if (!props.callerArtifacts) return null;
  const items = sessionArtifactItems(props.callerArtifacts, props.callerSessionId, props.sessionId);
  if (items === null) return <OwnAgentArtifacts hostId={props.hostId} sessionId={props.sessionId} className={props.className} onOpenSession={props.onOpenSession} />;
  return items.length > 0 ? (
    <ChipsFrame className={props.className} onOpenSession={props.onOpenSession}>
      <AgentArtifactChips hostId={props.hostId} sessionId={props.sessionId} items={items} />
    </ChipsFrame>
  ) : null;
}

function OwnAgentArtifacts(props: { readonly hostId: string; readonly sessionId: string; readonly className: string; readonly onOpenSession: () => void }) {
  const { snapshot } = useSessionArtifacts(props.hostId, props.sessionId, false);
  if (snapshot.state.kind !== "ready" || snapshot.state.artifacts.own.length === 0) return null;
  return (
    <ChipsFrame className={props.className} onOpenSession={props.onOpenSession}>
      <AgentArtifactChips hostId={props.hostId} sessionId={props.sessionId} items={snapshot.state.artifacts.own} />
    </ChipsFrame>
  );
}

/**
 * A folded group's totals: one chip per kind across its sessions. A total
 * opens the caller's Artifacts screen, which lists each session's items under
 * its name. Nothing shows while the group is open: its rows show every item.
 */
export function AgentGroupArtifactTotals(props: {
  readonly hostId: string;
  readonly callerSessionId: string;
  readonly callerArtifacts: SessionArtifacts | null;
  readonly sessionIds: readonly string[];
}) {
  const navigation = useNavigation<Navigation>();
  const { callerArtifacts, callerSessionId } = props;
  if (!callerArtifacts) return null;
  const totals = chipTotals(props.sessionIds.map((sessionId) => sessionArtifactItems(callerArtifacts, callerSessionId, sessionId) ?? []));
  if (totals.length === 0) return null;
  const openAll = () => navigation.push("ThreadArtifacts", { hostId: props.hostId, sessionId: callerSessionId });
  return (
    <View className="min-w-0 flex-row flex-wrap gap-1.5 pb-2">
      {totals.map((total) => (
        <Chip
          key={total.kind}
          tone={total.tone}
          label={total.label}
          note={null}
          pullRequestState={total.pullRequestState}
          onPress={openAll}
        />
      ))}
    </View>
  );
}
