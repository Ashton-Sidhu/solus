// The web view settings follow T3 Code apps/mobile/src/features/threads/HtmlRenderWebView.tsx (MIT, see UPSTREAM.md).
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { ConversationStore } from "../conversation/conversation-store";
import {
  artifactDocument,
  artifactThemeCss,
  artifactThemeScript,
  isArtifactDocumentUrl,
  isExternalLink,
  readArtifactHeight,
} from "./artifact-frame";
import { useTranscriptItem } from "./use-transcript-items";

const INITIAL_HEIGHT = 120;

/** The last height each render reported, so a row the list mounts again keeps its size. */
const reportedHeights = new Map<string, number>();

/**
 * An agent's HTML page in the shared Solus theme. The document is built once
 * per page; a theme change is posted into it, so the page keeps its state.
 */
function ArtifactWebView(props: {
  readonly html: string;
  readonly title: string;
  /** In the feed the page grows to its content; full screen it scrolls. */
  readonly scrollable: boolean;
  readonly onHeight?: (height: number) => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const canvas = useUniwindTheme()["--color-screen"];
  const themeCss = artifactThemeCss(themeAppearance, canvas, props.scrollable);
  const [initialThemeCss] = useState(themeCss);
  const source = useMemo(() => ({ html: artifactDocument(props.html, initialThemeCss) }), [props.html, initialThemeCss]);
  const webView = useRef<WebView<object>>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const restarted = useRef(false);

  useEffect(() => {
    if (loaded) webView.current?.injectJavaScript(artifactThemeScript(themeCss));
  }, [loaded, themeCss]);

  // A page that keeps crashing its web process is not reloaded forever.
  const restart = () => {
    if (restarted.current) {
      setFailed(true);
      return;
    }
    restarted.current = true;
    setLoaded(false);
    setGeneration((value) => value + 1);
  };

  if (failed) {
    return (
      <View className="flex-1 items-center justify-center" accessibilityRole="alert">
        <Text className="text-sm text-foreground-muted">This artifact could not be rendered.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <WebView<object>
        key={generation}
        ref={webView}
        source={source}
        originWhitelist={["about:*", "data:*"]}
        accessibilityLabel={props.title}
        style={{ flex: 1, backgroundColor: "transparent" }}
        allowsInlineMediaPlayback
        scrollEnabled={props.scrollable}
        bounces={props.scrollable}
        overScrollMode={props.scrollable ? "always" : "never"}
        showsVerticalScrollIndicator={props.scrollable}
        showsHorizontalScrollIndicator={props.scrollable}
        // Frames inside the page load; any other top-level navigation is a
        // link, which opens in the browser.
        onShouldStartLoadWithRequest={(request) => {
          if (request.isTopFrame === false || isArtifactDocumentUrl(request.url)) return true;
          if (isExternalLink(request.url)) void Linking.openURL(request.url);
          return false;
        }}
        onOpenWindow={(event) => {
          const url = event.nativeEvent.targetUrl;
          if (isExternalLink(url)) void Linking.openURL(url);
        }}
        onMessage={(event: WebViewMessageEvent) => {
          const height = readArtifactHeight(event.nativeEvent.data);
          if (height !== null) props.onHeight?.(height);
        }}
        onLoadEnd={() => setLoaded(true)}
        onError={() => setFailed(true)}
        onContentProcessDidTerminate={restart}
        onRenderProcessGone={restart}
      />
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <ActivityIndicator />
        </View>
      )}
    </View>
  );
}

function ArtifactFullScreen(props: { readonly html: string; readonly title: string; readonly onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={props.onClose}>
      <View className="flex-1 bg-screen" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View className="h-12 flex-row items-center gap-2 px-4">
          <Text numberOfLines={1} className="flex-1 font-t3-medium text-base text-foreground">
            {props.title}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close artifact"
            hitSlop={8}
            onPress={props.onClose}
            className="h-11 w-11 items-center justify-center"
          >
            <SymbolView name="xmark" size={16} tintColorClassName="accent-icon-muted" type="monochrome" />
          </Pressable>
        </View>
        <View className="flex-1 px-4">
          <ArtifactWebView html={props.html} title={props.title} scrollable />
        </View>
      </View>
    </Modal>
  );
}

/**
 * An HTML render in the feed. The latest revision of a work shows the page;
 * an earlier revision is one line that opens it in place.
 */
export const ThreadArtifact = memo(function ThreadArtifact(props: {
  readonly store: ConversationStore;
  readonly id: string;
  readonly superseded: boolean;
}) {
  const item = useTranscriptItem(props.store, props.id);
  const [height, setHeight] = useState(() => reportedHeights.get(props.id) ?? INITIAL_HEIGHT);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  if (item?.kind !== "artifact") return null;

  const showsPage = !props.superseded || earlierOpen;
  const onHeight = (next: number) => {
    reportedHeights.set(props.id, next);
    setHeight(next);
  };

  return (
    <View className="mb-2 px-1">
      {props.superseded ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: earlierOpen }}
          accessibilityLabel={`${item.title}, earlier version`}
          onPress={() => setEarlierOpen((open) => !open)}
          className="min-h-11 flex-row items-center gap-2"
        >
          <Text numberOfLines={1} className="shrink font-t3-medium text-sm text-foreground-secondary">
            {item.title}
          </Text>
          <Text className="shrink-0 text-sm text-foreground-muted">earlier version</Text>
          <SymbolView
            name={earlierOpen ? "chevron.down" : "chevron.right"}
            size={13}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      ) : null}
      {showsPage ? (
        <View style={{ height }}>
          <ArtifactWebView html={item.html} title={item.title} scrollable={false} onHeight={onHeight} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.title} full screen`}
            hitSlop={8}
            onPress={() => setFullScreen(true)}
            className="absolute right-1.5 top-1.5 h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-card/80"
          >
            <SymbolView
              name="arrow.up.left.and.arrow.down.right"
              size={13}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        </View>
      ) : null}
      {fullScreen ? (
        <ArtifactFullScreen html={item.html} title={item.title} onClose={() => setFullScreen(false)} />
      ) : null}
    </View>
  );
});
