import type { EnvironmentId } from "@t3tools/contracts";
import type { BrowserNavigateOp } from "@solus/contracts/browser-types";
import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type Ref } from "react";
import { View, type ViewProps } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useListened } from "@solus-mobile/app/app-context";
import { solus } from "../../solus/runtime";
import { useAppForeground } from "../../lib/appState";
import { PreviewStreamWebView } from "../../solus/browser/PreviewStreamWebView";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

export interface TunnelNavigation {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** iOS only: the page's theme-color, else its background, as #rrggbb; empty when unknown. */
  readonly pageColor?: string;
}

const TUNNEL_FAILURE_CAUSES = ["environment", "port", "outdated"] as const;
type TunnelFailureCause = (typeof TUNNEL_FAILURE_CAUSES)[number];

export interface TunnelWebViewRef {
  readonly loadUrl: (url: string) => Promise<void>;
  readonly goBack: () => Promise<void>;
  readonly goForward: () => Promise<void>;
  readonly reload: () => Promise<void>;
}

export function TunnelWebView({
  environmentId,
  url,
  ref,
  onNavigationChange,
  onLoadError,
  onScrollDirection,
  onAccess,
  topInset,
  ...props
}: ViewProps & {
  readonly environmentId: EnvironmentId;
  readonly url: string;
  readonly ref?: Ref<TunnelWebViewRef>;
  readonly onNavigationChange: (navigation: TunnelNavigation) => void;
  /**
   * `url` is the address that failed, or empty when the platform does not report it.
   * `unsupported` means this device's webview cannot route localhost at all.
   */
  readonly onLoadError: (failure: {
    readonly url: string;
    readonly unsupported: boolean;
    readonly description: string;
    /** What the native proxy saw, shown with the error so a report carries it. iOS only. */
    readonly debug?: string;
    /**
     * Whether the environment itself was out of reach (`environment`), answered that nothing
     * listens on the port (`port`), or runs a T3 Code server without the tunnel (`outdated`).
     */
    readonly cause?: TunnelFailureCause;
  }) => void;
  /** Whether the last connection could get into the environment's tunnel at all. */
  readonly onAccess?: (available: boolean) => void;
  /** iOS only: room at the top the page scrolls under, for a bar laid over it. */
  readonly topInset?: number;
  /** Reported every few dozen points the page scrolls; "up" also at the top. */
  readonly onScrollDirection?: (direction: "up" | "down") => void;
}) {
  const [pageId, setPageId] = useState<string | null>(null);
  const request = useRef<{ url: string; host: string; result: Promise<string> } | null>(null);
  const [requestedUrl, setRequestedUrl] = useState(url);
  const [attempt, setAttempt] = useState(0);
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const pages = useListened(solus.browser.changes, () => solus.browser.pagesOf(environmentId));
  const page = pages.find((entry) => entry.browserPageId === pageId);
  const failure = (cause: Error) =>
    onLoadError({
      url,
      unsupported: false,
      description: cause.message,
      debug: cause.message,
      cause: solus.connections.state(environmentId)?.readiness === "ready" ? "port" : "environment",
    });
  const reportError = useEffectEvent(failure);
  useEffect(() => {
    let active = true;
    if (
      !request.current ||
      request.current.url !== requestedUrl ||
      request.current.host !== environmentId
    ) {
      request.current = {
        host: environmentId,
        url: requestedUrl,
        result: solus.browser.open(environmentId, requestedUrl),
      };
    }
    request.current.result.then(
      (id) => {
        if (active) setPageId(id);
      },
      (cause: Error) => {
        if (active) reportError(cause);
      },
    );
    return () => {
      active = false;
    };
  }, [environmentId, requestedUrl, attempt]);
  const reportPage = useEffectEvent(() => {
    if (!page) return;
    onAccess?.(true);
    onNavigationChange({
      url: page.url,
      title: page.title,
      loading: page.loadState === "loading",
      canGoBack: page.canGoBack,
      canGoForward: page.canGoForward,
    });
    if (page.loadState === "failed")
      failure(new Error(page.problem?.message ?? "Page failed to load."));
  });
  useEffect(() => {
    reportPage();
  }, [page]);
  const navigate = async (op: BrowserNavigateOp) => {
    if (!page) {
      if (op.kind === "goto") setRequestedUrl(op.url);
      request.current = null;
      setAttempt((n) => n + 1);
      return;
    }
    try {
      await solus.browser.navigate(environmentId, page.browserPageId, op);
    } catch (cause) {
      failure(cause instanceof Error ? cause : new Error(String(cause)));
    }
  };
  useImperativeHandle(ref, () => ({
    loadUrl: (next) => navigate({ kind: "goto", url: next }),
    goBack: () => navigate({ kind: "back" }),
    goForward: () => navigate({ kind: "forward" }),
    reload: () => navigate({ kind: "reload" }),
  }));
  return (
    <View {...props} style={[props.style, { paddingTop: topInset }]}>
      {page && focused && foreground ? (
        <PreviewStreamWebView
          hostId={environmentId}
          page={page}
          onScrollDirection={onScrollDirection}
          interactive
          background={themeVariables["--color-sheet-solid"]}
        />
      ) : null}
    </View>
  );
}
