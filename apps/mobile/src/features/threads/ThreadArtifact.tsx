// The web view settings follow T3 Code apps/mobile/src/features/threads/HtmlRenderWebView.tsx (MIT, see UPSTREAM.md).
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { appResultMessage } from "@solus/client-core/app-calls";
import { appHostAccessNotice } from "@solus/contracts/apps";

import { useApp } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { ConversationStore } from "../conversation/conversation-store";
import { useArtifactApp, type ArtifactApp } from "./artifact-app";
import {
  appResultScript,
  artifactDocument,
  artifactThemeCss,
  artifactThemeScript,
  isArtifactDocumentUrl,
  isExternalLink,
  readAppCall,
  readArtifactHeight,
} from "./artifact-frame";
import { confirmWithAlert } from "./ThreadMcpApp";
import { useTranscriptItem } from "./use-transcript-items";

const INITIAL_HEIGHT = 120;

/** The last height each page reported, so a row the list mounts again keeps its size. */
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
  /** What answers the page's calls when it is an app; without it each call gets an error. */
  readonly app?: ArtifactApp | null;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const canvas = useUniwindTheme()["--color-screen"];
  const themeCss = artifactThemeCss(themeAppearance, canvas, props.scrollable);
  const [initialThemeCss] = useState(themeCss);
  // The network hosts in force are part of the document's policy: a change of them is a new document.
  const appNetwork = props.app?.network;
  const source = useMemo(() => ({ html: artifactDocument(props.html, initialThemeCss, appNetwork) }), [props.html, initialThemeCss, appNetwork]);
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
          if (height !== null) return props.onHeight?.(height);
          // An app's call: the page always gets an answer, so it never waits.
          const call = readAppCall(event.nativeEvent.data);
          if (!call) return;
          const answer = props.app
            ? props.app.call(call.name, call.args)
            : Promise.reject(new Error("This view shows the app and cannot run its calls."));
          void appResultMessage(call.id, answer).then((result) => webView.current?.injectJavaScript(appResultScript(result)));
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

function ArtifactFullScreen(props: { readonly html: string; readonly title: string; readonly app?: ArtifactApp | null; readonly onClose: () => void }) {
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
          <ArtifactWebView html={props.html} title={props.title} scrollable app={props.app} />
        </View>
      </View>
    </Modal>
  );
}

/**
 * A page in the feed. It grows to the height it reports and opens full
 * screen. `heightKey` names the page across mounts, so a row the list mounts
 * again keeps its size.
 */
export function ArtifactPage(props: { readonly html: string; readonly title: string; readonly heightKey: string; readonly app?: ArtifactApp | null }) {
  const [height, setHeight] = useState(() => reportedHeights.get(props.heightKey) ?? INITIAL_HEIGHT);
  const [fullScreen, setFullScreen] = useState(false);
  const onHeight = (next: number) => {
    reportedHeights.set(props.heightKey, next);
    setHeight(next);
  };

  return (
    <>
      <View style={{ height }}>
        <ArtifactWebView html={props.html} title={props.title} scrollable={false} onHeight={onHeight} app={props.app} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${props.title} full screen`}
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
      {fullScreen ? (
        <ArtifactFullScreen html={props.html} title={props.title} app={props.app} onClose={() => setFullScreen(false)} />
      ) : null}
    </>
  );
}

/**
 * A render of a saved work. A page with an app manifest is an app
 * (docs/plans/apps.md): its calls go to the work's host, and its host access
 * shows above it, with Allow and Revoke for the host's owner.
 */
function SavedArtifactPage(props: {
  readonly store: ConversationStore;
  readonly html: string;
  readonly title: string;
  readonly workId: string | null;
  readonly heightKey: string;
}) {
  const api = useApp().connections.connection(props.store.controller.hostId)?.api;
  const artifactApp = useArtifactApp(api, props.workId, props.html, confirmWithAlert);
  const hostAccess = artifactApp?.state?.hostAccess ?? null;
  const notice = hostAccess ? appHostAccessNotice(hostAccess) : null;
  const allows = hostAccess?.state === "pending";

  return (
    <>
      {hostAccess && notice ? (
        <View accessibilityRole="summary" className="mb-2 flex-row items-center gap-2 rounded-lg border border-border px-3 py-2">
          <Text className="min-w-0 flex-1 text-sm text-foreground-muted">{notice}</Text>
          {hostAccess.canDecide ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={allows ? "Allow this app's host access" : "Revoke this app's host access"}
              onPress={() => artifactApp?.decideHostAccess(allows)}
              className="min-h-11 justify-center px-3"
            >
              <Text className="font-t3-medium text-sm text-foreground">{allows ? "Allow" : "Revoke"}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <ArtifactPage html={props.html} title={props.title} heightKey={props.heightKey} app={artifactApp} />
    </>
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
  const [earlierOpen, setEarlierOpen] = useState(false);
  const showsPage = !props.superseded || earlierOpen;
  // An `html_path` render holds the saved version; its HTML is read when the page shows.
  const awaitsSavedHtml = item?.kind === "artifact" && !item.html && !!item.contentVersion;
  const needsRead = awaitsSavedHtml && !item.loading && !item.error;
  useEffect(() => {
    if (showsPage && needsRead) void props.store.controller.ensureArtifact(props.id);
  }, [props.store, props.id, showsPage, needsRead]);
  if (item?.kind !== "artifact") return null;

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
      {showsPage && awaitsSavedHtml ? (
        <View className="min-h-28 items-center justify-center gap-2 rounded-2xl bg-subtle">
          {item.error ? (
            <>
              <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
                {item.error}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void props.store.controller.ensureArtifact(props.id)}
                className="min-h-11 justify-center px-4"
              >
                <Text className="font-t3-medium text-sm text-foreground">Try again</Text>
              </Pressable>
            </>
          ) : (
            <ActivityIndicator accessibilityLabel="Loading artifact" />
          )}
        </View>
      ) : showsPage ? (
        <SavedArtifactPage store={props.store} html={item.html} title={item.title} workId={item.workId} heightKey={props.id} />
      ) : null}
    </View>
  );
});
