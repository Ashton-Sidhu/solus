// Adapted from T3 Code apps/mobile/src/features/browser/PreviewStreamWebView.tsx (MIT, see UPSTREAM.md).
import { browserGuestViewport, type BrowserPage } from "@solus/contracts/browser-types";
import * as Clipboard from "expo-clipboard";
import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { ActivityIndicator, Alert, Platform, View } from "react-native";
import { WebView } from "react-native-webview";

import { useApp } from "../../app/app-context";
import { AppText } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { BrowserPageRequests } from "./BrowserPageRequests";
import { browserPageStatusLabel } from "./browserPages";
import { FrameBridge } from "./frame-bridge";
import type { BrowserFrameWatch } from "./native-browser";
import {
  editableProbeExpression,
  previewStreamDocument,
  previewStreamMessage,
  type PreviewStreamConfiguration,
} from "./preview-stream-document";
import { previewStreamSource } from "./preview-stream-source.generated";

export interface PreviewStreamRef {
  readonly paste: () => void;
  readonly togglePictureInPicture: () => void;
}

export interface PreviewPictureInPictureState {
  readonly supported: boolean;
  readonly active: boolean;
}

type PreviewStreamProps = {
  readonly ref?: Ref<PreviewStreamRef>;
  readonly hostId: string;
  readonly page: BrowserPage;
  readonly interactive: boolean;
  readonly background: string;
  /** The floating player: no status row and no words over the frame. */
  readonly compact?: boolean;
  readonly onPictureInPicture?: (state: PreviewPictureInPictureState, detail?: string) => void;
  /** True while frames show, so input reaches the page. */
  readonly onStreamingChange?: (streaming: boolean) => void;
  /** The viewer's CSS size, which "Fit to screen" asks the page to take. */
  readonly onSize?: (size: { readonly width: number; readonly height: number }) => void;
};

/** A page that cannot be driven still streams; only its input is held back. */
function pageTakesInput(page: BrowserPage): boolean {
  return !page.devToolsOpen && page.hostKind !== "none";
}

export function PreviewStreamWebView({ ref, ...props }: PreviewStreamProps) {
  const [attempt, setAttempt] = useState(0);
  const processRetried = useRef(false);
  const configuration = JSON.stringify({
    interactive: props.interactive,
    background: props.background,
  } satisfies PreviewStreamConfiguration);
  return (
    <PreviewStreamDocumentView
      key={`${attempt}:${props.page.browserPageId}:${configuration}`}
      {...props}
      ref={ref}
      configuration={configuration}
      onRetry={() => {
        processRetried.current = false;
        setAttempt((current) => current + 1);
      }}
      onStreaming={() => {
        processRetried.current = false;
      }}
      onRecoverProcess={() => {
        if (processRetried.current) return false;
        processRetried.current = true;
        setAttempt((current) => current + 1);
        return true;
      }}
    />
  );
}

function PreviewStreamDocumentView({
  ref,
  hostId,
  page,
  interactive,
  background,
  compact,
  configuration,
  onPictureInPicture,
  onStreamingChange,
  onSize,
  onRetry,
  onStreaming,
  onRecoverProcess,
}: PreviewStreamProps & {
  readonly configuration: string;
  readonly onRetry: () => void;
  readonly onStreaming: () => void;
  readonly onRecoverProcess: () => boolean;
}) {
  const app = useApp();
  const webView = useRef<WebView<object>>(null);
  const active = useRef(false);
  const failed = useRef(false);
  const bootstrapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watch = useRef<BrowserFrameWatch | null>(null);
  const [status, setStatus] = useState<"connecting" | "streaming" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const { browserPageId } = page;
  const takesInput = interactive && pageTakesInput(page);
  const inject = (script: string) => webView.current?.injectJavaScript(`${script}; true;`);
  // Made when the view mounts: it posts into the WebView, which only exists then.
  const bridge = useRef<FrameBridge | null>(null);
  const clearBootstrapTimer = () => {
    if (bootstrapTimer.current === null) return;
    clearTimeout(bootstrapTimer.current);
    bootstrapTimer.current = null;
  };
  const fail = (message: string) => {
    if (!active.current || failed.current) return;
    failed.current = true;
    clearBootstrapTimer();
    watch.current?.stop();
    watch.current = null;
    bridge.current?.reset();
    inject("window.SolusPreviewStream?.stop()");
    onStreamingChange?.(false);
    setError(message);
    setStatus("error");
  };
  const bootstrapTimedOut = useEffectEvent(() => fail("Browser viewer could not start. Reconnect to try again."));
  const streamEnded = useEffectEvent(() => onStreamingChange?.(false));
  // The stream lives exactly as long as this view.
  useLayoutEffect(() => {
    active.current = true;
    const view = webView.current;
    bridge.current = new FrameBridge((seq, base64) => view?.injectJavaScript(`window.SolusPreviewStream?.frame(${seq},"${base64}"); true;`));
    bootstrapTimer.current = setTimeout(bootstrapTimedOut, 15_000);
    return () => {
      if (bootstrapTimer.current !== null) clearTimeout(bootstrapTimer.current);
      bootstrapTimer.current = null;
      active.current = false;
      watch.current?.stop();
      watch.current = null;
      bridge.current?.reset();
      view?.injectJavaScript("window.SolusPreviewStream?.stop(); true;");
      streamEnded();
    };
  }, []);
  // The guest's own CSS viewport: input is in the page's coordinates, which a zoom divides.
  const { width: viewportWidth, height: viewportHeight } = browserGuestViewport(page);
  useEffect(() => {
    inject(`window.SolusPreviewStream?.viewport(${viewportWidth},${viewportHeight})`);
  }, [viewportWidth, viewportHeight]);
  useEffect(() => {
    inject(`window.SolusPreviewStream?.enabled(${JSON.stringify(takesInput)})`);
  }, [takesInput]);
  const [source] = useState(() => ({
    html: previewStreamDocument(configuration, previewStreamSource),
    baseUrl: Platform.OS === "android" ? "https://localhost/" : "file:///",
  }));
  const send = (op: Parameters<typeof app.browser.interact>[2]) =>
    app.browser.interact(hostId, browserPageId, op).then(
      (result) => setInputError(result.ok ? null : (result.message ?? "The page did not take the input.")),
      (cause: unknown) => setInputError(cause instanceof Error ? cause.message : String(cause)),
    );
  // Reads here rather than in the screen: a page switch during the iOS paste prompt unmounts
  // this view, so the text can never type into another page.
  const paste = () =>
    void Clipboard.getStringAsync().then(
      (text) => {
        if (text && takesInput) void send({ kind: "insertText", text });
      },
      () => Alert.alert("Could not read the clipboard"),
    );
  useImperativeHandle(ref, () => ({
    paste,
    togglePictureInPicture: () => inject("window.SolusPreviewStream?.pictureInPicture()"),
  }));
  const startFrames = () => {
    if (watch.current) return watch.current;
    watch.current = app.browser.watchFrames(
      hostId,
      browserPageId,
      (header, data) => bridge.current?.push(header.seq, data),
      (cause) => fail(cause.message || "This host cannot stream the page."),
    );
    return watch.current;
  };
  const processTerminated = () => {
    if (!active.current || failed.current) return;
    watch.current?.stop();
    watch.current = null;
    bridge.current?.reset();
    onStreamingChange?.(false);
    if (!onRecoverProcess()) fail("Browser viewer stopped. Reconnect to try again.");
  };
  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      {!compact ? (
        <View className="flex-row items-center gap-2 border-b border-secondary-border px-3 py-2">
          <AppText numberOfLines={2} className="flex-1 text-xs text-foreground-muted">
            {inputError ?? browserPageStatusLabel(page)}
          </AppText>
        </View>
      ) : null}
      <View className="relative flex-1">
        <WebView<object>
          ref={webView}
          source={source}
          originWhitelist={["*"]}
          scrollEnabled={false}
          bounces={false}
          mixedContentMode="always"
          allowUniversalAccessFromFileURLs
          contentInsetAdjustmentBehavior="never"
          setSupportMultipleWindows={false}
          allowsInlineMediaPlayback
          allowsPictureInPictureMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          style={{ flex: 1, backgroundColor: background }}
          onLoad={() => {
            inject(`window.SolusPreviewStream?.viewport(${viewportWidth},${viewportHeight})`);
            inject(`window.SolusPreviewStream?.enabled(${JSON.stringify(takesInput)})`);
          }}
          onError={() => fail("Browser viewer could not load. Reconnect to try again.")}
          onHttpError={() => fail("Browser viewer could not load. Reconnect to try again.")}
          onContentProcessDidTerminate={processTerminated}
          onRenderProcessGone={processTerminated}
          onShouldStartLoadWithRequest={(request) => request.url === "about:blank" || request.url === source.baseUrl}
          onMessage={(event) => {
            if (!active.current || failed.current) return;
            const message = previewStreamMessage(event.nativeEvent.data);
            if (message === null) return;
            switch (message.type) {
              case "painted":
                bridge.current?.painted(message.seq);
                return;
              case "size":
                // The host streams no more pixels than this viewer can show.
                startFrames().setCaps({
                  maxWidth: Math.ceil(message.width * message.pixelRatio),
                  maxHeight: Math.ceil(message.height * message.pixelRatio),
                });
                onSize?.({ width: message.width, height: message.height });
                return;
              case "input":
                void send(message.input);
                return;
              case "probe": {
                const { x, y } = message;
                void app.browser.interact(hostId, browserPageId, { kind: "evaluate", expression: editableProbeExpression(x, y) }).then(
                  (result) => inject(`window.SolusPreviewStream?.probeResult(${x},${y},${result.ok && result.value === "true"})`),
                  () => {},
                );
                return;
              }
              case "pictureInPicture":
                onPictureInPicture?.(message, message.detail);
                return;
              case "status":
                if (message.status !== "connecting") clearBootstrapTimer();
                if (message.status === "error") {
                  fail(message.detail ?? "Browser stream failed.");
                  return;
                }
                setStatus(message.status);
                onStreamingChange?.(message.status === "streaming");
                if (message.status === "streaming") onStreaming();
            }
          }}
        />
      </View>
      {status === "streaming" && !compact && interactive ? <BrowserPageRequests hostId={hostId} page={page} /> : null}
      {status !== "streaming" ? (
        <View className="absolute inset-0 items-center justify-center gap-4 px-6" style={{ backgroundColor: background }}>
          {status === "connecting" ? <ActivityIndicator colorClassName="accent-icon" /> : null}
          {compact ? null : (
            <AppText accessibilityLiveRegion="polite" className="text-center text-sm text-foreground-muted">
              {status === "error" ? error : "Connecting to browser..."}
            </AppText>
          )}
          {status === "error" && !compact ? <ControlPill variant="pill" label="Reconnect" onPress={onRetry} /> : null}
        </View>
      ) : null}
    </View>
  );
}
