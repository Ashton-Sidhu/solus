// Adapted from T3 Code apps/mobile/src/features/devices/DeviceStreamWebView.tsx (MIT, see UPSTREAM.md).
import type { DeviceButton, DeviceHostSummary, DevicePlatform, DeviceTarget } from "@solus/contracts/device-types";
import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { WebView } from "react-native-webview";

import { useApp } from "../../app/app-context";
import { AppText } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import {
  deviceStreamBaseUrl,
  deviceStreamDocument,
  deviceStreamMessage,
  type DeviceStreamConfiguration,
} from "./device-stream-document";
import { deviceStreamSource } from "./device-stream-source.generated";

export interface DeviceStreamRef {
  readonly press: (button: DeviceButton | "rotate") => void;
  readonly type: (text: string) => void;
}

type DeviceStreamProps = {
  readonly ref?: Ref<DeviceStreamRef>;
  readonly hostId: string;
  readonly target: DeviceTarget;
  readonly platform: DevicePlatform;
  readonly kind: DeviceHostSummary["kind"];
  /** True while this viewer holds the device's control lease; input reaches the device only then. */
  readonly enabled: boolean;
  readonly onTakeControl: () => Promise<boolean>;
  readonly colors: DeviceStreamConfiguration["colors"];
  readonly onStreamingChange: (streaming: boolean) => void;
};

export function DeviceStreamWebView({ ref, ...props }: DeviceStreamProps) {
  const [attempt, setAttempt] = useState(0);
  const processRetried = useRef(false);
  const configuration = JSON.stringify({
    platform: props.platform,
    kind: props.kind,
    colors: props.colors,
  } satisfies DeviceStreamConfiguration);
  return (
    <DeviceStreamDocumentView
      key={`${attempt}:${configuration}`}
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

function DeviceStreamDocumentView({
  ref,
  hostId,
  target,
  platform,
  kind,
  enabled,
  onTakeControl,
  colors,
  configuration,
  onStreamingChange,
  onRetry,
  onStreaming,
  onRecoverProcess,
}: DeviceStreamProps & {
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
  const [status, setStatus] = useState<"connecting" | "streaming" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const inject = (script: string) => webView.current?.injectJavaScript(`${script}; true;`);
  const clearBootstrapTimer = () => {
    if (bootstrapTimer.current === null) return;
    clearTimeout(bootstrapTimer.current);
    bootstrapTimer.current = null;
  };
  const fail = (message: string) => {
    if (!active.current || failed.current) return;
    failed.current = true;
    clearBootstrapTimer();
    onStreamingChange(false);
    inject("window.SolusDeviceStream?.stop()");
    setError(message);
    setStatus("error");
  };
  const bootstrapTimedOut = useEffectEvent(() => fail("Device viewer could not start. Reconnect to try again."));
  const streamEnded = useEffectEvent(() => onStreamingChange(false));
  // The stream lives exactly as long as this view.
  useLayoutEffect(() => {
    active.current = true;
    const view = webView.current;
    bootstrapTimer.current = setTimeout(bootstrapTimedOut, 15_000);
    return () => {
      if (bootstrapTimer.current !== null) clearTimeout(bootstrapTimer.current);
      bootstrapTimer.current = null;
      active.current = false;
      view?.injectJavaScript("window.SolusDeviceStream?.stop(); true;");
      streamEnded();
    };
  }, []);
  useEffect(() => {
    inject(`window.SolusDeviceStream?.enabled(${JSON.stringify(enabled)})`);
  }, [enabled]);
  const [source] = useState(() => ({
    html: deviceStreamDocument(configuration, deviceStreamSource),
    baseUrl: deviceStreamBaseUrl(Platform.OS, { platform, kind }, app.devices.httpBaseOf(hostId)),
  }));
  useImperativeHandle(ref, () => ({
    press: (button) => inject(`window.SolusDeviceStream?.command(${JSON.stringify(button)})`),
    type: (text) => inject(`window.SolusDeviceStream?.text(${JSON.stringify(text)})`),
  }));
  const processTerminated = () => {
    if (!active.current || failed.current) return;
    onStreamingChange(false);
    if (!onRecoverProcess()) fail("Device viewer stopped. Reconnect to try again.");
  };
  return (
    <View className="flex-1" style={{ backgroundColor: colors.background }}>
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
        mediaPlaybackRequiresUserAction={false}
        style={{ flex: 1, backgroundColor: colors.background }}
        onLoad={() => inject(`window.SolusDeviceStream?.enabled(${JSON.stringify(enabled)})`)}
        onError={() => fail("Device viewer could not load. Reconnect to try again.")}
        onHttpError={() => fail("Device viewer could not load. Reconnect to try again.")}
        onContentProcessDidTerminate={processTerminated}
        onRenderProcessGone={processTerminated}
        onShouldStartLoadWithRequest={(request) => request.url === "about:blank" || request.url === source.baseUrl}
        onMessage={(event) => {
          if (!active.current || failed.current) return;
          const message = deviceStreamMessage(event.nativeEvent.data);
          if (message === null) return;
          if (message.type === "control") {
            void onTakeControl().then(
              (granted) => inject(granted ? "window.SolusDeviceStream?.enabled(true)" : "window.SolusDeviceStream?.controlRefused()"),
              () => inject("window.SolusDeviceStream?.controlRefused()"),
            );
            return;
          }
          if (message.type === "url") {
            const { requestId } = message;
            void app.devices.streamUrl(hostId, target).then(
              (url) => inject(`window.SolusDeviceStream?.url(${requestId},${JSON.stringify(url)})`),
              () => inject(`window.SolusDeviceStream?.url(${requestId},null)`),
            );
            return;
          }
          if (message.status !== "connecting") clearBootstrapTimer();
          if (message.status === "error") {
            fail(message.detail ?? "Device stream failed.");
            return;
          }
          setStatus(message.status);
          onStreamingChange(message.status === "streaming");
          if (message.status === "streaming") onStreaming();
        }}
      />
      {status !== "streaming" ? (
        <View className="absolute inset-0 items-center justify-center gap-4 px-6" style={{ backgroundColor: colors.background }}>
          {status === "connecting" ? <ActivityIndicator colorClassName="accent-icon" /> : null}
          <AppText accessibilityLiveRegion="polite" className="text-center text-sm text-foreground-muted">
            {status === "error" ? error : "Connecting to device..."}
          </AppText>
          {status === "error" ? <ControlPill variant="pill" label="Reconnect" onPress={onRetry} /> : null}
        </View>
      ) : null}
    </View>
  );
}
