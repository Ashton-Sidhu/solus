import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  overflow: null as ((event: { nativeEvent: { data: string } }) => void) | null,
  openedLinks: [] as string[],
  openWindow: null as ((event: { nativeEvent: { targetUrl: string } }) => void) | null,
}));

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children, style }: Children & { style?: { height?: number } }) => <div data-height={style?.height}>{children}</div>,
  Pressable: ({ children }: Children) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: Children) => <div>{children}</div> }));
vi.mock("react-native-webview", () => ({
  WebView: (props: { onOpenWindow: typeof harness.openWindow; onMessage: typeof harness.overflow }) => {
    harness.openWindow = props.onOpenWindow;
    harness.overflow = props.onMessage;
    return null;
  },
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../lib/htmlRenderTheme", () => ({
  mobileHtmlRenderTheme: () => ({ variables: {} }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({}),
}));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: () => ({ _tag: "Initial" }),
  useRefreshAssetUrl: () => async () => null,
}));
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => async (url: string) => {
    harness.openedLinks.push(url);
    return true;
  },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));

import { HtmlRenderWebView, InlineHtmlRender } from "./HtmlRenderWebView";

it("opens a render's issue link the way the thread's own links open", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(<HtmlRenderWebView uri="https://assets.test/render.html" title="Links" nested />),
  );

  const issueUrl = "https://github.com/pingdotgg/t3code/issues/41939";
  await act(async () => harness.openWindow?.({ nativeEvent: { targetUrl: issueUrl } }));

  expect(harness.openedLinks).toEqual([issueUrl]);
  await act(async () => root.unmount());
});

it("keeps the reserved transcript height when the embedded page reports overflow", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<InlineHtmlRender html="<p>diagram</p>" title="Diagram" height={323} />));
  expect(container.querySelector('[data-height="323"]')).not.toBeNull();
  expect(harness.overflow).toBeTypeOf("function");
  await act(async () => harness.overflow?.({ nativeEvent: {
    data: JSON.stringify({ type: "t3-html-render-overflow", x: false, y: true, height: 640 }),
  } }));
  expect(container.querySelector('[data-height="323"]')).not.toBeNull();
  expect(container.querySelector('[data-height="640"]')).toBeNull();
  await act(async () => root.unmount());
});
