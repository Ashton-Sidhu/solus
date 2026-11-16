// Adapted from T3 Code apps/mobile/src/features/browser/BrowserPreviewRouteScreen.tsx (MIT, see UPSTREAM.md).
import { addressProblem, navigableAddress } from "@solus/client-core/browser-address";
import type { BrowserNavigateOp, BrowserPage } from "@solus/contracts/browser-types";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useIsFocused } from "@react-navigation/native";
import { useContext, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AppText } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { ScreenHeader } from "../../components/ScreenHeader";
import { useAppForeground } from "../../lib/appState";
import type { ScreenProps } from "../../navigation/routes";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { BrowserTabMenu } from "./BrowserTabMenu";
import { browserPageTitle, browserPageUrl, latestBrowserPage } from "./browserPages";
import { PreviewStreamWebView, type PreviewPictureInPictureState, type PreviewStreamRef } from "./PreviewStreamWebView";

const NO_PICTURE_IN_PICTURE: PreviewPictureInPictureState = { supported: false, active: false };

export function BrowserPreviewRouteScreen({ route, navigation }: ScreenProps<"ThreadBrowserPreview">) {
  const { hostId, sessionId } = route.params;
  const app = useApp();
  const insets = useSafeAreaInsets();
  // The iOS v5 header lies over the screen; the Android native stack places the screen below it.
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const pages = useListened(app.browser.changes, () => app.browser.pagesOf(hostId));
  const loaded = useListened(app.browser.changes, () => app.browser.loadedOf(hostId));
  const error = useListened(app.browser.changes, () => app.browser.errorOf(hostId));
  const [selectedPageId, setSelectedPageId] = useState(route.params.browserPageId ?? null);
  const [pictureInPicture, setPictureInPicture] = useState(NO_PICTURE_IN_PICTURE);
  const [streaming, setStreaming] = useState(false);
  const [viewerSize, setViewerSize] = useState<{ width: number; height: number } | null>(null);
  const [hadPages, setHadPages] = useState(false);
  const streamRef = useRef<PreviewStreamRef>(null);
  const page = pages.find((entry) => entry.browserPageId === selectedPageId) ?? latestBrowserPage(pages, sessionId);
  const pageId = page?.browserPageId ?? null;
  if (pageId !== null && pageId !== selectedPageId) {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedPageId(pageId);
  }
  if (pages.length > 0 && !hadPages) setHadPages(true);
  useEffect(() => {
    void app.browser.load(hostId);
  }, [app, hostId]);
  // The last page closed while this viewer showed it: there is nothing left to show.
  useEffect(() => {
    if (focused && loaded && hadPages && pages.length === 0) navigation.goBack();
  }, [focused, loaded, hadPages, pages.length, navigation]);
  const onPictureInPicture = (state: PreviewPictureInPictureState, detail?: string) => {
    setPictureInPicture({ supported: state.supported, active: state.active });
    if (detail) Alert.alert("Picture in picture is unavailable", detail);
  };
  const selectPage = (next: string) => {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedPageId(next);
  };
  const live = (focused && foreground) || pictureInPicture.active;

  return (
    <View className="flex-1 bg-sheet" style={{ paddingTop: Platform.OS === "ios" ? headerHeight : 0, paddingBottom: insets.bottom }}>
      <BrowserHeader
        onClose={() => navigation.goBack()}
        page={page}
        pages={pages}
        pictureInPicture={pictureInPicture}
        onPictureInPicture={() => streamRef.current?.togglePictureInPicture()}
        onSelectPage={selectPage}
      />
      {page ? (
        <>
          <BrowserAddressBar
            key={`address:${page.browserPageId}`}
            hostId={hostId}
            page={page}
            streaming={streaming}
            viewerSize={viewerSize}
            onPaste={() => streamRef.current?.paste()}
          />
          {live ? (
            <PreviewStreamWebView
              key={`stream:${page.browserPageId}`}
              ref={streamRef}
              hostId={hostId}
              page={page}
              interactive
              background={themeVariables["--color-sheet-solid"]}
              onPictureInPicture={onPictureInPicture}
              onStreamingChange={setStreaming}
              onSize={setViewerSize}
            />
          ) : (
            <View className="flex-1" />
          )}
        </>
      ) : (
        <BrowserEmpty loaded={loaded} live={focused && foreground} error={error} onRetry={() => void app.browser.load(hostId)} />
      )}
    </View>
  );
}

function BrowserHeader(props: {
  readonly onClose: () => void;
  readonly page: BrowserPage | null;
  readonly pages: ReadonlyArray<BrowserPage>;
  readonly pictureInPicture: PreviewPictureInPictureState;
  readonly onPictureInPicture: () => void;
  readonly onSelectPage: (browserPageId: string) => void;
}) {
  const { pictureInPicture } = props;
  return (
    <ScreenHeader
      title={props.page ? browserPageTitle(props.page) : "Browser"}
      sidebar={false}
      close={{ accessibilityLabel: "Close browser", onPress: props.onClose }}
      actions={
        // Android WebView cannot play video in picture in picture.
        Platform.OS === "ios" && pictureInPicture.supported
          ? [
              {
                accessibilityLabel: pictureInPicture.active ? "Exit picture in picture" : "Picture in picture",
                icon: { ios: pictureInPicture.active ? "pip.exit" : "pip.enter", android: "visibility" },
                selected: pictureInPicture.active,
                onPress: props.onPictureInPicture,
              },
            ]
          : []
      }
      menus={
        props.pages.length > 1
          ? [
              {
                title: "Tabs",
                icon: "square.on.square",
                items: props.pages.map((entry) => ({
                  id: entry.browserPageId,
                  title: browserPageTitle(entry),
                  subtitle: entry.label || browserPageUrl(entry),
                  selected: entry.browserPageId === props.page?.browserPageId,
                  onPress: () => props.onSelectPage(entry.browserPageId),
                })),
              },
            ]
          : []
      }
    />
  );
}

/** No page yet: still loading, the host has no browser, or nothing is open. */
function BrowserEmpty(props: { readonly loaded: boolean; readonly live: boolean; readonly error: string | null; readonly onRetry: () => void }) {
  return (
    <View className="flex-1 items-center justify-center gap-4 px-6">
      {!props.loaded ? (
        props.live ? <ActivityIndicator colorClassName="accent-icon" /> : null
      ) : (
        <>
          <AppText selectable={!!props.error} className="text-center text-sm text-foreground-muted">
            {props.error ?? "No browser pages are open on this host. Pages an agent opens show here."}
          </AppText>
          {props.error ? <ControlPill variant="pill" label="Retry" onPress={props.onRetry} /> : null}
        </>
      )}
    </View>
  );
}

function BrowserAddressBar({
  hostId,
  page,
  streaming,
  viewerSize,
  onPaste,
}: {
  readonly hostId: string;
  readonly page: BrowserPage;
  readonly streaming: boolean;
  readonly viewerSize: { readonly width: number; readonly height: number } | null;
  readonly onPaste: () => void;
}) {
  const app = useApp();
  const url = browserPageUrl(page);
  const [draft, setDraft] = useState<string | null>(null);
  const ready = streaming && !page.devToolsOpen;
  const navigate = (op: BrowserNavigateOp) =>
    void app.browser.navigate(hostId, page.browserPageId, op).catch((cause: unknown) =>
      Alert.alert("Could not open this address", cause instanceof Error ? cause.message : undefined),
    );
  const submit = () => {
    const value = (draft ?? url).trim();
    setDraft(null);
    if (!value) return;
    const problem = addressProblem(value);
    if (problem) {
      Alert.alert("Could not open this address", problem);
      return;
    }
    navigate({ kind: "goto", url: navigableAddress(value) });
  };
  return (
    <View className="flex-row items-center gap-1 px-2 pb-2">
      <ControlPill icon="chevron.left" accessibilityLabel="Back" disabled={!ready || !page.canGoBack} onPress={() => navigate({ kind: "back" })} />
      <ControlPill icon="chevron.right" accessibilityLabel="Forward" disabled={!ready || !page.canGoForward} onPress={() => navigate({ kind: "forward" })} />
      <TextInput
        accessibilityLabel="Address"
        editable={ready}
        value={draft ?? url}
        onChangeText={setDraft}
        onBlur={() => setDraft(null)}
        onSubmitEditing={submit}
        placeholder="Enter a URL"
        placeholderTextColorClassName="accent-placeholder"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        selectTextOnFocus
        lineBreakModeIOS="tail"
        className="h-10 min-w-0 flex-1 rounded-full border border-input-border bg-input px-4 font-sans text-sm text-foreground"
      />
      <ControlPill icon="arrow.clockwise" accessibilityLabel="Reload page" disabled={!ready} onPress={() => navigate({ kind: "reload" })} />
      <BrowserTabMenu hostId={hostId} page={page} streaming={streaming} viewerSize={viewerSize} onPaste={ready ? onPaste : undefined} />
    </View>
  );
}
