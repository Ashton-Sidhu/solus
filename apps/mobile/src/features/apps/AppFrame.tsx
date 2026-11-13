// The web view settings follow T3 Code apps/mobile/src/features/threads/HtmlRenderWebView.tsx (MIT, see UPSTREAM.md).
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { APP_DATA_CHANGED_MESSAGE } from "@solus/client-core/app-calls";

import { useApp } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { artifactThemeCss, artifactThemeScript, isArtifactDocumentUrl, isExternalLink } from "../threads/artifact-frame";
import { appDocument, appMessageScript, relayAppCall } from "./app-frame";

/**
 * The app frame (docs/plans/apps.md §9): the UI of an app in all of the
 * screen. The document is built once for each UI and network policy; a theme
 * change is posted into it, so the UI keeps its state. Each call of the UI
 * goes to the app's host, and a change of the app's data is posted into the
 * UI, so its queries run again. A link that leaves the app opens in the browser.
 */
export function AppFrame(props: {
  readonly hostId: string;
  /** The app's id on its host. */
  readonly appId: string;
  readonly title: string;
  readonly html: string;
  /** The network hosts the frame may reach. */
  readonly network: readonly string[];
  /** Grows each time the app's data changed outside this frame. */
  readonly dataVersion: number;
}) {
  const { hostId, appId } = props;
  const app = useApp();
  const { themeAppearance } = useAppearancePreferences();
  const canvas = useUniwindTheme()["--color-screen"];
  const themeCss = artifactThemeCss(themeAppearance, canvas, true);
  const [initialThemeCss] = useState(themeCss);
  // The network hosts are part of the document's policy: a change of them is a
  // new document. A read that gives the same hosts again is not.
  const networkKey = props.network.join(" ");
  const source = useMemo(
    () => ({ html: appDocument(props.html, initialThemeCss, networkKey ? networkKey.split(" ") : []) }),
    [props.html, initialThemeCss, networkKey],
  );
  const webView = useRef<WebView<object>>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const restarted = useRef(false);

  useEffect(() => {
    if (loaded) webView.current?.injectJavaScript(artifactThemeScript(themeCss));
  }, [loaded, themeCss]);

  // The UI reads its data when it loads, so only a change after that is posted.
  const postedDataVersion = useRef(props.dataVersion);
  useEffect(() => {
    if (!loaded || postedDataVersion.current === props.dataVersion) return;
    postedDataVersion.current = props.dataVersion;
    webView.current?.injectJavaScript(appMessageScript(APP_DATA_CHANGED_MESSAGE));
  }, [loaded, props.dataVersion]);

  const callHost = (name: string, argumentsJson: string) => {
    const current = app.connections.connection(hostId);
    if (!current) return Promise.reject(new Error("This app's host is not connected."));
    return current.api.appCall({ appId, name, argumentsJson });
  };

  // A UI that keeps crashing its web process is not reloaded forever.
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
        <Text className="text-sm text-foreground-muted">This app could not be shown.</Text>
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
        // Frames inside the UI load, and a page of the UI is a place in its own
        // document; any other top-level navigation is a link, which opens in
        // the browser.
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
          void relayAppCall(event.nativeEvent.data, callHost).then((script) => {
            if (script) webView.current?.injectJavaScript(script);
          });
        }}
        onLoadEnd={() => setLoaded(true)}
        onError={() => setFailed(true)}
        onContentProcessDidTerminate={restart}
        onRenderProcessGone={restart}
      />
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <ActivityIndicator accessibilityLabel="Opening the app" colorClassName="accent-icon-muted" />
        </View>
      )}
    </View>
  );
}
