import { useFocusEffect } from "@react-navigation/native";
import type { SessionArtifact } from "@solus/contracts/session-artifacts";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { AppSymbolName } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { EmptyState } from "../../../components/EmptyState";
import { ListRow } from "../../../components/ListRow";
import { ListRowLayout } from "../../../components/ListRowLayout";
import { ListSection } from "../../../components/ListSection";
import { ScreenScrollView } from "../../../components/ScreenScrollView";
import { cn } from "../../../lib/cn";
import type { ScreenProps } from "../../../navigation/routes";
import { HostStatusBanner } from "../../hosts/HostStatusBanner";
import {
  artifactFilterChips,
  artifactKey,
  artifactRowText,
  artifactSections,
  type ArtifactFilter,
} from "./session-artifacts";
import { useOpenArtifact } from "./use-open-artifact";
import { useSessionArtifacts } from "./use-session-artifacts";

const KIND_ICON = {
  "pull-request": "arrow.triangle.pull",
  work: "doc.text",
  file: "doc",
  image: "photo",
  automation: "clock",
} satisfies Record<SessionArtifact["kind"], AppSymbolName>;

/**
 * What a session produced or linked (docs/plans/session-artifacts.md). Pull
 * requests open their screen, or the browser when no project of the host
 * reads them; files and images open the file screen of their host. Works and
 * automations have no screen on the phone, so their rows only name them.
 */
export function ArtifactsScreen({ route }: ScreenProps<"ThreadArtifacts">) {
  const { hostId, sessionId } = route.params;
  const insets = useSafeAreaInsets();
  const { feed, snapshot } = useSessionArtifacts(hostId, sessionId, false);
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  // Open clears the unread mark, and keeps it clear while open.
  useFocusEffect(useCallback(() => feed.view(), [feed]));

  const { open, opens } = useOpenArtifact(hostId, sessionId);

  const state = snapshot.state;
  let body;
  if (state.kind === "loading") {
    body = (
      <View className="items-center py-10">
        <ActivityIndicator colorClassName="accent-icon-muted" />
      </View>
    );
  } else if (state.kind === "error") {
    body = (
      <EmptyState
        variant="plain"
        title="Artifacts could not be read"
        detail={state.message}
        actionLabel="Try again"
        onAction={() => void feed.load()}
      />
    );
  } else {
    const chips = artifactFilterChips(state.artifacts);
    // A kind that is gone after a reload has no chip: show all.
    const activeFilter = chips.some((chip) => chip.filter === filter) ? filter : "all";
    const sections = artifactSections(state.artifacts, activeFilter);
    body =
      sections.length === 0 ? (
        <EmptyState
          variant="plain"
          title="Nothing linked yet."
          detail="Pull requests, works, files, and automations of this session show here."
        />
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
            {chips.map((chip) => (
              <Pressable
                key={chip.filter}
                accessibilityRole="button"
                accessibilityLabel={`${chip.label}, ${chip.count}`}
                accessibilityState={{ selected: chip.filter === activeFilter }}
                onPress={() => setFilter(chip.filter)}
                className={cn(
                  "h-8 flex-row items-center gap-1.5 rounded-full px-3 active:opacity-70",
                  chip.filter === activeFilter ? "bg-primary" : "bg-subtle",
                )}
              >
                <Text
                  className={cn(
                    "text-sm font-t3-medium",
                    chip.filter === activeFilter ? "text-primary-foreground" : "text-foreground",
                  )}
                >
                  {chip.label}
                </Text>
                <Text
                  className={cn(
                    "text-xs",
                    chip.filter === activeFilter ? "text-primary-foreground" : "text-foreground-muted",
                  )}
                >
                  {chip.count}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          {sections.map((section) => (
            <ListSection key={section.key} title={section.title}>
              {section.items.map((item) => {
                const text = artifactRowText(item);
                return opens(item) ? (
                  <ListRow
                    key={artifactKey(item)}
                    icon={KIND_ICON[item.kind]}
                    label={text.title}
                    description={text.detail}
                    onPress={() => open(item)}
                  />
                ) : (
                  <View key={artifactKey(item)} accessible accessibilityLabel={`${text.title}, ${text.detail}`}>
                    <ListRowLayout
                      icon={KIND_ICON[item.kind]}
                      label={text.title}
                      description={
                        item.kind === "work" || item.kind === "automation"
                          ? `${text.detail} · Open it on desktop or web`
                          : text.detail
                      }
                    />
                  </View>
                );
              })}
            </ListSection>
          ))}
        </>
      );
  }

  return (
    <ScreenScrollView
      className="flex-1 bg-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      <HostStatusBanner hostId={hostId} />
      {body}
    </ScreenScrollView>
  );
}
