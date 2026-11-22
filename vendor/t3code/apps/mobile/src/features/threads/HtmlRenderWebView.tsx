import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  clampHtmlRenderHeight,
  injectHtmlRenderBootstrap,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  type HtmlRenderReference,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import { injectMcpAppCsp } from "@t3tools/shared/mcpApp";
import { T, useGT } from "gt-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Platform, Pressable, View, type ColorValue } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { webViewDecelerationRate } from "../../lib/webViewDecelerationRate";

const ROW_BOTTOM_MARGIN = 8;
const ACTION_ROW_HEIGHT = 32;
const FULL_SCREEN_GUTTER = 16;

export function htmlRenderRowHeight(frameHeight: number) {
  return ACTION_ROW_HEIGHT + frameHeight + ROW_BOTTOM_MARGIN;
}

function useHtmlRenderTheme() {
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  return useMemo(
    () =>
      mobileHtmlRenderTheme({
        themeId,
        appearance: themeAppearance,
        variables: themeVariables,
        systemColors: systemColorsActive,
        platform: Platform.OS,
      }),
    [themeId, themeAppearance, themeVariables, systemColorsActive],
  );
}

function postTheme(view: WebView<object> | null, theme: HtmlRenderTheme) {
  view?.injectJavaScript(
    `window.postMessage(${JSON.stringify(htmlRenderThemeMessage(theme))}, "*"); true;`,
  );
}

const OVERFLOW_MESSAGE_TYPE = "t3-html-render-overflow";

const OVERFLOW_SCRIPT = `(function(){var last;function report(){var d=document.documentElement,b=document.body;var x=Math.max(d.scrollWidth,b?b.scrollWidth:0)>window.innerWidth+1,y=Math.max(d.scrollHeight,b?b.scrollHeight:0)>window.innerHeight+1,h=Math.ceil(d.getBoundingClientRect().height),o=x+","+y+","+h;if(o===last)return;last=o;window.ReactNativeWebView.postMessage(JSON.stringify({type:${JSON.stringify(OVERFLOW_MESSAGE_TYPE)},x:x,y:y,height:h}));}report();if(window.ResizeObserver){var r=new ResizeObserver(report);r.observe(document.documentElement);if(document.body)r.observe(document.body);}window.addEventListener("resize",report);})();true;`;

type Overflow = { readonly x: boolean; readonly y: boolean; readonly height: number };

const NO_OVERFLOW: Overflow = { x: false, y: false, height: 0 };

function readOverflowMessage(data: string): Overflow | null {
  try {
    const message: unknown = JSON.parse(data);
    return typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === OVERFLOW_MESSAGE_TYPE &&
      "x" in message &&
      typeof message.x === "boolean" &&
      "y" in message &&
      typeof message.y === "boolean" &&
      "height" in message &&
      typeof message.height === "number" &&
      Number.isFinite(message.height)
      ? { x: message.x, y: message.y, height: message.height }
      : null;
  } catch {
    return null;
  }
}

const withoutFragment = (url: string) => url.split("#", 1)[0];

export function HtmlRenderWebView(
  props: (
    | { readonly uri: string; readonly html?: never }
    | { readonly html: string; readonly uri?: never }
  ) & {
    readonly onHeight?: (height: number) => void;
    readonly title: string;
    readonly nested: boolean;
    readonly onLoadError?: () => void;
  },
) {
  const theme = useHtmlRenderTheme();
  const [initialTheme] = useState(theme);
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [overflow, setOverflow] = useState(NO_OVERFLOW);
  const webView = useRef<WebView<object>>(null);
  const crashes = useRef(0);
  const shownTheme = useRef<HtmlRenderTheme | null>(null);
  const source = useMemo(
    () =>
      props.html === undefined
        ? { uri: props.uri + htmlRenderThemeFragment(initialTheme) }
        : {
            html: injectMcpAppCsp(injectHtmlRenderBootstrap(props.html), {
              resourceDomains: ["https:"],
              connectDomains: ["https:"],
            }),
          },
    [props.html, props.uri, initialTheme],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts theme changes into the already loaded WebView
  useEffect(() => {
    if (shownTheme.current === null || shownTheme.current === theme) return;
    shownTheme.current = theme;
    postTheme(webView.current, theme);
  }, [theme]);
  const restart = () => {
    crashes.current += 1;
    if (crashes.current > 1) {
      props.onLoadError?.();
      return;
    }
    shownTheme.current = null;
    setLoaded(false);
    setOverflow(NO_OVERFLOW);
    setGeneration((value) => value + 1);
  };
  const scrollable = !props.nested || overflow.x || overflow.y;
  return (
    <View
      style={
        props.nested
          ? { flex: 1 }
          : {
              flex: 1,
              paddingHorizontal: FULL_SCREEN_GUTTER,
              backgroundColor: theme.variables["--background"],
            }
      }
    >
      <WebView<object>
        key={generation}
        ref={webView}
        source={source}
        {...(props.html !== undefined && {
          originWhitelist: ["*"],
          allowFileAccess: false,
          allowFileAccessFromFileURLs: false,
          allowUniversalAccessFromFileURLs: false,
          // The Android incognito setter clears cookies for every WebView in the app.
          incognito: Platform.OS === "ios",
        })}
        accessibilityLabel={props.title}
        style={{ flex: 1, backgroundColor: "transparent" }}
        allowsInlineMediaPlayback
        contentInsetAdjustmentBehavior={props.nested ? "never" : "automatic"}
        bounces={!props.nested}
        showsVerticalScrollIndicator={!props.nested}
        showsHorizontalScrollIndicator={!props.nested}
        scrollEnabled={scrollable}
        decelerationRate={webViewDecelerationRate}
        // Android's patched WebView always keeps horizontal drags. Only pages
        // with vertical overflow hold vertical drags until they reach an edge.
        nestedScrollEnabled={props.nested && overflow.y}
        overScrollMode={props.nested ? "never" : "always"}
        onShouldStartLoadWithRequest={(request) =>
          request.isTopFrame === false ||
          withoutFragment(request.url) === withoutFragment(props.uri ?? "about:blank")
        }
        onOpenWindow={(event) => {
          const url = event.nativeEvent.targetUrl;
          if (/^https?:/i.test(url)) void tryOpenExternalUrl(url, "html-render");
        }}
        onLoadEnd={() => {
          setLoaded(true);
          shownTheme.current = theme;
          if (props.html !== undefined || theme !== initialTheme) postTheme(webView.current, theme);
        }}
        onError={props.onLoadError}
        onHttpError={props.onLoadError}
        onContentProcessDidTerminate={restart}
        onRenderProcessGone={restart}
        {...(props.nested
          ? {
              injectedJavaScript: OVERFLOW_SCRIPT,
              onMessage: (event: WebViewMessageEvent) => {
                const next = readOverflowMessage(event.nativeEvent.data);
                if (next !== null) {
                  setOverflow(next);
                  if (next.height > 0) props.onHeight?.(clampHtmlRenderHeight(next.height));
                }
              },
            }
          : {})}
      />
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator />
        </View>
      )}
    </View>
  );
}

export function ThreadHtmlRender(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly render: HtmlRenderReference;
  readonly frameWidth: number;
  readonly iconColor: ColorValue;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const { attachmentId, title } = props.render;
  const height = htmlRenderFrameHeight(props.render, props.frameWidth);
  const fileName = htmlRenderFileName(title);
  const resource = {
    _tag: "attachment" as const,
    attachmentId,
    fileName,
    mimeType: "text/html",
    disposition: "inline" as const,
  };
  const asset = useAssetUrlState(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  // Signed URLs are re-minted periodically; following them would reload the page.
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null && asset._tag === "Success") setUri(asset.url);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retried = useRef(false);
  const handleLoadError = () => {
    if (retried.current) {
      setFailed(true);
      return;
    }
    retried.current = true;
    void refresh().then((next) => {
      if (next === null) setFailed(true);
      else if (next !== uri) setUri(next);
      else setAttempt((value) => value + 1);
    });
  };

  return (
    <View style={{ marginBottom: ROW_BOTTOM_MARGIN }}>
      <View style={{ height: ACTION_ROW_HEIGHT }} className="flex-row items-start justify-end">
        {uri !== null && !failed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Open {title}", { title })}
            hitSlop={8}
            className="h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card/80"
            onPress={() =>
              navigation.navigate("ThreadAttachment", {
                environmentId: String(props.environmentId),
                threadId: String(props.threadId),
                attachmentId,
                name: fileName,
                mimeType: "text/html",
                sizeBytes: "0",
                htmlRender: "1",
              })
            }
          >
            <SymbolView
              name="arrow.up.left.and.arrow.down.right"
              size={12}
              tintColor={props.iconColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>
      <View style={{ height }}>
        {uri !== null && !failed ? (
          <HtmlRenderWebView
            key={`${uri}:${attempt}`}
            uri={uri}
            title={title}
            nested
            onLoadError={handleLoadError}
          />
        ) : failed || asset._tag === "Failure" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Reload {title}", { title })}
            className="flex-1 items-center justify-center"
            onPress={() => {
              retried.current = false;
              setFailed(false);
              if (uri === null) void refresh().then((next) => next !== null && setUri(next));
            }}
          >
            <Text className="text-sm text-foreground-muted">
              <T>Page unavailable</T>
            </Text>
          </Pressable>
        ) : (
          <View className="flex-1 items-center justify-center">
            <AppActivityIndicator />
          </View>
        )}
      </View>
    </View>
  );
}

/** Solus supplies page content directly and has no T3 attachment URL to open. */
export function InlineHtmlRender({
  html,
  title,
}: {
  readonly html: string;
  readonly title: string;
}) {
  const gt = useGT();
  const [height, setHeight] = useState(120);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const page = (nested: boolean) =>
    failed ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("Reload {title}", { title })}
        className="flex-1 items-center justify-center"
        onPress={() => setFailed(false)}
      >
        <Text className="text-sm text-foreground-muted">
          <T>Page unavailable</T>
        </Text>
      </Pressable>
    ) : (
      <HtmlRenderWebView
        html={html}
        title={title}
        nested={nested}
        onHeight={nested ? setHeight : undefined}
        onLoadError={() => setFailed(true)}
      />
    );
  return (
    <View style={{ marginBottom: ROW_BOTTOM_MARGIN }}>
      <View style={{ height: ACTION_ROW_HEIGHT }} className="flex-row items-start justify-end">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Open {title}", { title })}
          hitSlop={8}
          className="h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card/80"
          onPress={() => setExpanded(true)}
        >
          <SymbolView
            name="arrow.up.left.and.arrow.down.right"
            size={12}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      </View>
      <View style={{ height }}>{page(true)}</View>
      {expanded && (
        <Modal
          visible
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => setExpanded(false)}
        >
          <SafeAreaView className="flex-1 bg-screen">
            <View className="h-12 flex-row items-center gap-2 px-4">
              <Text numberOfLines={1} className="flex-1 font-t3-medium text-base text-foreground">
                {title}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Close {title}", { title })}
                className="h-11 w-11 items-center justify-center"
                onPress={() => setExpanded(false)}
              >
                <SymbolView
                  name="xmark"
                  size={16}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
              </Pressable>
            </View>
            {page(false)}
          </SafeAreaView>
        </Modal>
      )}
    </View>
  );
}
