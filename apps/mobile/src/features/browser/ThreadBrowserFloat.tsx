// Adapted from T3 Code apps/mobile/src/features/browser/ThreadBrowserFloat.tsx (MIT, see UPSTREAM.md).
import { useIsFocused } from "@react-navigation/native";
import type { BrowserPage } from "@solus/contracts/browser-types";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";

import { useApp, useListened } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { useAppForeground } from "../../lib/appState";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { browserPageTitle } from "./browserPages";
import { PreviewStreamWebView } from "./PreviewStreamWebView";

const PLAYER_LONG_SIDE = 184;
const PLAYER_ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const PLAYER_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

/**
 * A small live player over the thread when this session's agent asks to show
 * a page (`browser.surfaceRequested`), as a desktop pane opens for it. Only a
 * request made while the thread is open pops it; tapping it opens the viewer.
 */
export function ThreadBrowserFloat(props: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly top: number;
  readonly onOpen: (browserPageId: string) => void;
}) {
  const app = useApp();
  const pages = useListened(app.browser.changes, () => app.browser.pagesOf(props.hostId));
  const reveal = useListened(app.browser.changes, () => app.browser.revealOf(props.hostId));
  // The request already on the host when the thread opened does not pop the player.
  const [seenRequestId, setSeenRequestId] = useState(() => reveal?.requestId ?? 0);
  const [browserPageId, setBrowserPageId] = useState<string | null>(null);
  if (reveal && reveal.requestId > seenRequestId) {
    setSeenRequestId(reveal.requestId);
    if (reveal.sessionId === props.sessionId) setBrowserPageId(reveal.browserPageId);
  }
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const page = pages.find((entry) => entry.browserPageId === browserPageId) ?? null;
  if (!page || !focused) return null;
  return (
    <FloatingBrowserPlayer
      hostId={props.hostId}
      page={page}
      live={foreground}
      top={props.top}
      onOpen={() => {
        setBrowserPageId(null);
        props.onOpen(page.browserPageId);
      }}
      onClose={() => setBrowserPageId(null)}
    />
  );
}

function FloatingBrowserPlayer(props: {
  readonly hostId: string;
  readonly page: BrowserPage;
  readonly live: boolean;
  readonly top: number;
  readonly onOpen: () => void;
  readonly onClose: () => void;
}) {
  const { themeVariables } = useAppearancePreferences();
  const { viewport } = props.page;
  const aspect = Math.min(Math.max(viewport.width / viewport.height, 0.5), 2);
  const width = aspect >= 1 ? PLAYER_LONG_SIDE : Math.round(PLAYER_LONG_SIDE * aspect);
  const height = Math.round(width / aspect);
  const background = themeVariables["--color-sheet-solid"];
  return (
    <Animated.View
      entering={PLAYER_ENTERING}
      exiting={PLAYER_EXITING}
      className="absolute right-3 z-30 overflow-hidden rounded-2xl border border-border shadow-md shadow-black/20"
      style={{ top: props.top, width, height, backgroundColor: background }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open browser, ${browserPageTitle(props.page)}`}
        accessibilityHint="Opens the browser page full screen"
        onPress={props.onOpen}
        className="flex-1"
      >
        <View pointerEvents="none" className="flex-1">
          {props.live ? (
            <PreviewStreamWebView hostId={props.hostId} page={props.page} interactive={false} background={background} compact />
          ) : null}
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close floating preview"
        hitSlop={8}
        onPress={props.onClose}
        className="absolute right-1.5 top-1.5 size-6 items-center justify-center rounded-full bg-black/55"
      >
        <SymbolView name="xmark" size={11} tintColor="#ffffff" type="monochrome" />
      </Pressable>
    </Animated.View>
  );
}
