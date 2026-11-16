import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import {
  recentArtifactAccessibilityLabel,
  recentArtifactAge,
  recentArtifactKey,
  type RecentArtifact,
} from "@solus/client-core/recent-artifacts";
import { Pressable, ScrollView, View } from "react-native";

import { useApp } from "../../../app/app-context";
import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { PierreEntryIcon } from "../../../components/PierreEntryIcon";
import { useHostMediaUrl } from "../../files/host-media-url";
import { artifactRowText } from "./session-artifacts";
import type { ArtifactOpener } from "./use-open-artifact";

/**
 * The row at the top of the Threads screen (docs/plans/session-artifacts.md
 * decision 17), as a section of its own with no card, as desktop and web draw it: the works, apps, files, and images
 * of the session and the sessions it started, pinned first, then the latest
 * opened, changed, or added. A work has no screen on the phone, so its card
 * only shows it.
 */
export function RecentArtifactsRow(props: {
  readonly hostId: string;
  readonly items: readonly RecentArtifact[];
  readonly opener: ArtifactOpener;
}) {
  // The screen draws again when it comes back into view, which is when an age can have moved.
  const now = Date.now();
  return (
    // A section of its own, titled as the lists under it are, with no card around it.
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-3 px-2">
        <Text className="shrink text-sm font-t3-medium text-foreground-muted">Pinned and recent</Text>
        <Text className="text-sm tabular-nums text-foreground-muted">{props.items.length}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-3 px-0.5">
        {props.items.map((item) => (
          <RecentArtifactCard key={recentArtifactKey(item.owned.artifact)} hostId={props.hostId} item={item} now={now} opener={props.opener} />
        ))}
      </ScrollView>
    </View>
  );
}

function RecentArtifactCard(props: { readonly hostId: string; readonly item: RecentArtifact; readonly now: number; readonly opener: ArtifactOpener }) {
  const artifact = props.item.owned.artifact;
  const title = artifactRowText(artifact).title;
  const label = recentArtifactAccessibilityLabel(title, props.item, props.now);
  const body = (
    <>
      <View className="h-24 w-full overflow-hidden rounded-xl border border-border bg-card">
        <Thumbnail hostId={props.hostId} item={props.item} title={title} />
        {props.item.pinned ? (
          <View className="absolute right-1.5 top-1.5 size-6 items-center justify-center rounded-md bg-primary">
            <SymbolView name="pin" size={12} tintColorClassName="accent-primary-foreground" />
          </View>
        ) : null}
      </View>
      <View className="flex-row items-baseline gap-2 px-0.5">
        <Text numberOfLines={1} className="min-w-0 flex-1 text-sm leading-[18px] text-foreground">
          {title}
        </Text>
        <Text className="text-xs tabular-nums text-foreground-muted">{recentArtifactAge(props.item, props.now)}</Text>
      </View>
    </>
  );
  if (!props.opener.opens(artifact)) {
    return (
      <View accessible accessibilityLabel={`${label}, open it on desktop or web`} className="w-40 gap-1.5">
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        void Haptics.selectionAsync();
        props.opener.open(artifact);
      }}
      className="w-40 gap-1.5 active:opacity-70"
    >
      {body}
    </Pressable>
  );
}

function Thumbnail(props: { readonly hostId: string; readonly item: RecentArtifact; readonly title: string }) {
  const artifact = props.item.owned.artifact;
  switch (artifact.kind) {
    case "work":
      return artifact.workType === "artifact" ? (
        <View className="flex-1 items-center justify-center bg-artifact-drawn-fill">
          <SymbolView name="chevron.left.forwardslash.chevron.right" size={22} tintColorClassName="accent-artifact-drawn" />
        </View>
      ) : (
        // The page itself, small: its title, then the start of its text.
        <View className="flex-1 gap-1 px-2.5 pt-2">
          <Text numberOfLines={1} className="text-[9px] font-t3-medium text-foreground">
            {props.title}
          </Text>
          <Text numberOfLines={6} className="text-[7px] leading-[10px] text-foreground-muted">
            {artifact.preview ?? ""}
          </Text>
        </View>
      );
    case "image":
      return <ImageThumbnail hostId={props.hostId} path={artifact.path} />;
    case "file":
      return (
        <View className="flex-1 items-center justify-center">
          <PierreEntryIcon path={artifact.path} size={28} />
        </View>
      );
    case "app":
      return (
        <View className="flex-1 items-center justify-center bg-artifact-app-fill">
          <SymbolView name="square.grid.2x2" size={22} tintColorClassName="accent-artifact-app" />
        </View>
      );
    default:
      return null;
  }
}

function ImageThumbnail(props: { readonly hostId: string; readonly path: string }) {
  const app = useApp();
  const { state } = useHostMediaUrl(app.connections.connection(props.hostId), { path: props.path });
  if (state.kind !== "ready") {
    return (
      <View className="flex-1 items-center justify-center">
        <SymbolView name="photo" size={22} tintColorClassName="accent-foreground-muted" />
      </View>
    );
  }
  return <Image source={{ uri: state.url }} contentFit="cover" style={{ flex: 1 }} accessibilityIgnoresInvertColors />;
}
