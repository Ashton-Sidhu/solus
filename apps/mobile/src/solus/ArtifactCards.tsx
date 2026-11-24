import { useEffect, useState, type ReactNode } from "react";
import { useGT } from "gt-react-native";
import { Pressable, ScrollView, View } from "react-native";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import type { TranscriptItem } from "@solus-mobile/features/conversation/lib/transcript-model";
import { RequestActionButton } from "@solus-mobile/features/threads/RequestActionButton";
import { useTranscriptItem } from "@solus-mobile/features/threads/use-transcript-items";
import { workHistoryKey } from "@solus/client-core/person-history";
import { InlineHtmlRender } from "../features/threads/HtmlRenderWebView";
import { AppActivityIndicator } from "../components/ui/AppActivityIndicator";
import { SymbolView } from "../components/ui/AppSymbol";
import { AppText } from "../components/ui/AppText";
import {
  artifactGroupCounts,
  artifactGroupView,
  artifactVersion,
  changeArtifactGroupView,
  pickArtifactRevision,
  selectedRevision,
  selectedTab,
  type ArtifactGroup,
  type ArtifactGroupTab,
} from "./artifact-groups";
import { solus } from "./runtime";

type ArtifactItem = Extract<TranscriptItem, { kind: "artifact" }>;

/** A saved render: the page, or its loading and error states while the card reads the saved version. */
function ArtifactBody({
  store,
  item,
  overlay,
}: {
  store: ConversationStore;
  item: ArtifactItem;
  overlay?: ReactNode;
}) {
  const { workId } = item;
  const pending = !item.html && !!item.contentVersion;
  const needsRead = pending && !item.loading && !item.error;
  useEffect(() => {
    if (needsRead) void store.controller.ensureArtifact(item.id);
  }, [store, item.id, needsRead]);
  if (!pending)
    return (
      <InlineHtmlRender
        html={item.html}
        title={item.title}
        overlay={overlay}
        onOpen={workId ? () => solus.history.record(workHistoryKey(workId)) : undefined}
      />
    );
  return (
    <View className="min-h-28">
      {item.error ? (
        <View className="min-h-28 items-center justify-center">
          <AppText accessibilityRole="alert">{item.error}</AppText>
          <RequestActionButton
            label="Try again"
            onPress={() => void store.controller.ensureArtifact(item.id)}
          />
        </View>
      ) : (
        <AppActivityIndicator accessibilityLabel="Loading artifact" />
      )}
      {overlay}
    </View>
  );
}

export function ArtifactCard({
  store,
  item,
  superseded,
}: {
  store: ConversationStore;
  item: ArtifactItem;
  superseded: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="px-1">
      {superseded && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          className="min-h-11 justify-center"
          onPress={() => setExpanded(!expanded)}
        >
          <AppText className="text-sm text-foreground-secondary">
            {item.title} · earlier version
          </AppText>
        </Pressable>
      )}
      {(!superseded || expanded) && <ArtifactBody store={store} item={item} />}
    </View>
  );
}

function GroupTab({
  store,
  tab,
  selected,
  onSelect,
}: {
  store: ConversationStore;
  tab: ArtifactGroupTab;
  selected: boolean;
  onSelect: () => void;
}) {
  const item = useTranscriptItem(store, tab.revisions[tab.turnRevision]!);
  const title = item?.kind === "artifact" ? item.title : "";
  const { version } = artifactVersion(tab, tab.turnRevision);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`${title}, v${version}`}
      accessibilityState={{ selected }}
      hitSlop={{ top: 3, bottom: 3 }}
      onPress={onSelect}
      className={
        selected
          ? "h-[38px] flex-row items-center gap-1.5 rounded-full bg-card px-3.5 shadow-sm shadow-black/10"
          : "h-[38px] flex-row items-center gap-1.5 rounded-full px-3.5 active:opacity-70"
      }
    >
      <AppText
        numberOfLines={1}
        className={
          selected
            ? "max-w-[150px] text-sm font-medium text-foreground"
            : "max-w-[150px] text-sm text-foreground-muted"
        }
      >
        {title}
      </AppText>
      <AppText className="font-mono text-[11px] text-foreground-muted">v{version}</AppText>
    </Pressable>
  );
}

/** The version pill in the corner of the render: "v4 of 4" and the arrows. */
function VersionPill({
  tab,
  revision,
  onPick,
}: {
  tab: ArtifactGroupTab;
  revision: number;
  onPick: (revision: number) => void;
}) {
  const gt = useGT();
  const { version, total } = artifactVersion(tab, revision);
  const hasVersions = tab.revisions.length > 1;
  const arrow = (direction: -1 | 1) => {
    const target = revision + direction;
    const disabled = target < 0 || target >= tab.revisions.length;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={direction < 0 ? gt("Previous version") : gt("Next version")}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => onPick(target)}
        className={
          disabled ? "h-9 w-9 items-center justify-center opacity-35" : "h-9 w-9 items-center justify-center rounded-full active:bg-subtle"
        }
      >
        <SymbolView
          name={direction < 0 ? "chevron.left" : "chevron.right"}
          size={14}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
    );
  };
  return (
    <View
      className={
        hasVersions
          ? "absolute right-2 top-2 flex-row items-center rounded-full border border-border bg-card py-0.5 pl-2.5 pr-1 shadow-md shadow-black/20"
          : "absolute right-2 top-2 flex-row items-center rounded-full border border-border bg-card px-2.5 py-1.5 shadow-md shadow-black/20"
      }
    >
      <AppText className="font-mono text-[11px] text-foreground-muted">
        {gt("v{version} of {total}", { version, total })}
      </AppText>
      {hasVersions && arrow(-1)}
      {hasVersions && arrow(1)}
    </View>
  );
}

function GroupRender({
  store,
  revisionKey,
  overlay,
}: {
  store: ConversationStore;
  revisionKey: string;
  overlay: ReactNode;
}) {
  const item = useTranscriptItem(store, revisionKey);
  return item?.kind === "artifact" ? <ArtifactBody store={store} item={item} overlay={overlay} /> : null;
}

/** Two or more saved works that one turn wrote: tabs, one render, and a version pill. */
export function ArtifactGroupCard({ store, group }: { store: ConversationStore; group: ArtifactGroup }) {
  const gt = useGT();
  const [view, setView] = useState(() => artifactGroupView(store, group.id));
  const [overflow, setOverflow] = useState({ width: 0, content: 0, offset: 0 });
  const tab = group.tabs[selectedTab(group, view)]!;
  const revision = selectedRevision(tab, view);
  const counts = artifactGroupCounts(group);
  const changes =
    counts.updated && counts.created
      ? gt("{updated} updated · {created} new", counts)
      : counts.created
        ? gt("{created} new", counts)
        : gt("{updated} updated", counts);
  const fold = (folded: boolean) => setView(changeArtifactGroupView(store, group.id, { folded }));
  const showsFade = overflow.content > overflow.width + 1 && overflow.offset + overflow.width < overflow.content - 1;
  if (view.folded)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("{artifacts} artifacts, {changes}", { artifacts: counts.artifacts, changes })}
        accessibilityState={{ expanded: false }}
        onPress={() => fold(false)}
        className="min-h-11 flex-row items-center gap-1.5 px-1 active:opacity-70"
      >
        <SymbolView name="square.grid.2x2" size={13} tintColorClassName="accent-primary" type="monochrome" />
        <AppText className="text-sm font-medium text-foreground">
          {gt("{artifacts} artifacts", counts)}
        </AppText>
        <AppText className="text-sm text-foreground-muted">{changes}</AppText>
        <SymbolView name="chevron.right" size={13} tintColorClassName="accent-icon-muted" type="monochrome" />
      </Pressable>
    );
  return (
    <View className="gap-2 px-1">
      <View className="flex-row items-center gap-1">
        <View className="min-w-0 flex-1">
          <ScrollView
            horizontal
            accessibilityRole="tablist"
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={32}
            onLayout={(event) => {
              const width = event.nativeEvent.layout.width;
              setOverflow((current) => (current.width === width ? current : { ...current, width }));
            }}
            onContentSizeChange={(content) =>
              setOverflow((current) => (current.content === content ? current : { ...current, content }))
            }
            onScroll={(event) => {
              const offset = event.nativeEvent.contentOffset.x;
              setOverflow((current) => (current.offset === offset ? current : { ...current, offset }));
            }}
            className="max-w-full grow-0 self-start rounded-full bg-subtle"
            contentContainerClassName="gap-0.5 p-[3px]"
          >
            {group.tabs.map((entry) => (
              <GroupTab
                key={entry.workId}
                store={store}
                tab={entry}
                selected={entry === tab}
                onSelect={() => setView(changeArtifactGroupView(store, group.id, { workId: entry.workId }))}
              />
            ))}
          </ScrollView>
          {showsFade && (
            <View
              pointerEvents="none"
              className="absolute inset-y-0 right-0 w-8 rounded-r-full bg-linear-to-r from-transparent to-subtle"
            />
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Fold artifacts")}
          accessibilityState={{ expanded: true }}
          onPress={() => fold(true)}
          className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle"
        >
          <SymbolView name="chevron.down" size={14} tintColorClassName="accent-icon-muted" type="monochrome" />
        </Pressable>
      </View>
      <GroupRender
        key={tab.revisions[revision]}
        store={store}
        revisionKey={tab.revisions[revision]!}
        overlay={
          <VersionPill
            tab={tab}
            revision={revision}
            onPick={(target) =>
              setView(pickArtifactRevision(store, group.id, tab.workId, tab.revisions[target]!))
            }
          />
        }
      />
    </View>
  );
}
