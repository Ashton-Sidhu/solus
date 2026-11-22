import { SheetHeader } from "../../components/ui/SheetHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { useListened } from "@solus-mobile/app/app-context";
import { solus } from "../../solus/runtime";
import { AppText } from "../../components/ui/AppText";
import { msg, useGT } from "gt-react-native";
import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { m } from "../../i18n/messages";
import { useAppForeground } from "../../lib/appState";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { BrowserChrome } from "./BrowserBar";
import { BrowserTabMenu } from "./BrowserTabMenu";
import {
  browserPageTitle,
  browserPageUrl,
  latestBrowserPage,
} from "../../solus/browser/browserPages";
import {
  PreviewStreamWebView,
  type PreviewPictureInPictureState,
  type PreviewStreamRef,
} from "../../solus/browser/PreviewStreamWebView";

const NO_PICTURE_IN_PICTURE: PreviewPictureInPictureState = { supported: false, active: false };

type BrowserPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly tabId?: string;
}>;

export function BrowserPreviewRouteScreen({ route }: BrowserPreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = () => navigation.goBack();
  const { environmentId, threadId } = route.params;
  if (!environmentId?.trim() || !threadId?.trim()) {
    return <BrowserUnavailableScreen onClose={onClose} />;
  }
  return (
    <BrowserPreviewScreen
      environmentId={EnvironmentId.make(environmentId)}
      threadId={ThreadId.make(threadId)}
      initialTabId={route.params.tabId ?? null}
      onClose={onClose}
    />
  );
}

function BrowserUnavailableScreen({ onClose }: { readonly onClose: () => void }) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const contentTopInset = useContentTopInset();
  return (
    <View
      className="flex-1 bg-sheet"
      style={{ paddingTop: contentTopInset, paddingBottom: insets.bottom }}
    >
      <SheetHeader
        title={gt("Browser", { $context: "screen title" })}
        onClose={onClose}
        accessibilityLabel={gt("Close browser")}
      />
    </View>
  );
}

function BrowserPreviewScreen({
  environmentId,
  threadId,
  initialTabId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly initialTabId: string | null;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [selectedTabId, setSelectedTabId] = useState(initialTabId);
  const [pictureInPicture, setPictureInPicture] = useState(NO_PICTURE_IN_PICTURE);
  const [streaming, setStreaming] = useState(false);
  const [viewerSize, setViewerSize] = useState<{ width: number; height: number } | null>(null);
  const streamRef = useRef<PreviewStreamRef>(null);
  const tabs = useListened(solus.browser.changes, () => solus.browser.pagesOf(environmentId));
  const loaded = useListened(solus.browser.changes, () => solus.browser.loadedOf(environmentId));
  const error = useListened(solus.browser.changes, () => solus.browser.errorOf(environmentId));
  useEffect(() => {
    void solus.browser.load(environmentId);
  }, [environmentId]);
  const tab =
    tabs.find((entry) => entry.browserPageId === selectedTabId) ??
    latestBrowserPage(tabs, threadId);
  const tabId = tab?.browserPageId ?? null;
  if (tabId !== null && tabId !== selectedTabId) {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedTabId(tabId);
  }
  const onPictureInPicture = (state: PreviewPictureInPictureState, detail?: string) => {
    setPictureInPicture({ supported: state.supported, active: state.active });
    if (detail) Dialog.alert(m(msg("Picture in picture is unavailable")), detail);
  };
  const selectTab = (next: string) => {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedTabId(next);
  };
  const live = (focused && foreground) || pictureInPicture.active;

  const ready = streaming && !!tab && !tab.devToolsOpen && tab.hostKind !== "none";
  const navigate = (op: import("@solus/contracts/browser-types").BrowserNavigateOp) => {
    const work = tab
      ? solus.browser.navigate(environmentId, tab.browserPageId, op)
      : op.kind === "goto"
        ? solus.browser.open(environmentId, op.url).then(selectTab)
        : null;
    void work?.catch((cause: Error) =>
      Dialog.alert(m(msg("Could not open this address")), cause.message),
    );
  };
  const showPictureInPicture =
    // Android WebView cannot play video in picture in picture.
    Platform.OS === "ios" && pictureInPicture.supported;

  return (
    // The route spans the Duo's rail, so the screen insets its own sides.
    <SafeAreaView
      edges={["left", "right"]}
      style={{ flex: 1, backgroundColor: themeVariables["--color-sheet-solid"] }}
    >
      <BrowserChrome
        key={tab ? `address:${tab.browserPageId}` : "address"}
        scrollsUnderBar={false}
        bar={{
          url: tab ? browserPageUrl(tab) : "",
          editable: ready || !tab,
          canGoBack: ready && (tab?.canGoBack ?? false),
          onClose,
          onBack: () => navigate({ kind: "back" }),
          onReload: () => navigate({ kind: "reload" }),
          onSubmit: (value) => {
            const url = normalizedOrNull(value);
            if (url === null)
              Dialog.alert(
                m(msg("Could not open this address")),
                m(msg("Enter an http or https URL.")),
              );
            else navigate({ kind: "goto", url });
          },
          trailing: (
            <>
              {showPictureInPicture ? (
                <ControlPill
                  icon={{
                    ios: pictureInPicture.active ? "pip.exit" : "pip.enter",
                    android: "visibility",
                  }}
                  accessibilityLabel={
                    pictureInPicture.active
                      ? gt("Exit picture in picture")
                      : gt("Picture in picture")
                  }
                  onPress={() => streamRef.current?.togglePictureInPicture()}
                />
              ) : null}
              {tabs.length > 1 ? (
                <Menu
                  accessible
                  accessibilityLabel={gt("Tabs", { $context: "browser tabs menu" })}
                  accessibilityRole="button"
                  actions={tabs.map((entry) => ({
                    id: entry.browserPageId,
                    title: browserPageTitle(entry),
                    subtitle: browserPageUrl(entry),
                    state: entry.browserPageId === tabId ? "on" : "off",
                  }))}
                  onPressAction={({ nativeEvent }) => selectTab(nativeEvent.event)}
                >
                  <ControlPill
                    icon="square.on.square"
                    accessibilityLabel={gt("Tabs", { $context: "browser tabs menu" })}
                  />
                </Menu>
              ) : null}
              {tab ? (
                <BrowserTabMenu
                  hostId={environmentId}
                  page={tab}
                  viewerSize={viewerSize}
                  streaming={streaming}
                  onPaste={ready ? () => streamRef.current?.paste() : undefined}
                />
              ) : null}
            </>
          ),
        }}
      >
        {({ onScrollDirection }) =>
          tab ? (
            live ? (
              <PreviewStreamWebView
                key={`stream:${tab.browserPageId}`}
                hostId={environmentId}
                page={tab}
                ref={streamRef}
                interactive
                background={themeVariables["--color-sheet-solid"]}
                onPictureInPicture={onPictureInPicture}
                onStreamingChange={setStreaming}
                onSize={setViewerSize}
                onScrollDirection={onScrollDirection}
              />
            ) : (
              <View className="flex-1" />
            )
          ) : (
            <View className="flex-1 items-center justify-center">
              {error || loaded ? (
                <AppText onPress={() => void solus.browser.load(environmentId)}>
                  {error ?? "Enter a URL to open a page."}
                </AppText>
              ) : focused && foreground ? (
                <AppActivityIndicator color={themeVariables["--color-icon"]} />
              ) : null}
            </View>
          )
        }
      </BrowserChrome>
    </SafeAreaView>
  );
}

function normalizedOrNull(value: string): string | null {
  try {
    return normalizePreviewUrl(value);
  } catch {
    return null;
  }
}
