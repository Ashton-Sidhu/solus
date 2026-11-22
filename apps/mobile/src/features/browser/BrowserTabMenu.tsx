// Adapted from T3 Code apps/mobile/src/features/browser/BrowserTabMenu.tsx (MIT, see UPSTREAM.md).
import type { MenuAction } from "@react-native-menu/menu";
import {
  DEVICE_PRESETS,
  browserZoomOf,
  stepBrowserZoom,
  type BrowserAppearance,
  type BrowserPage,
  type BrowserViewportRequest,
} from "@solus/contracts/browser-types";
import { Alert } from "react-native";

import { solus as app } from "../../solus/runtime";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu as ControlPillMenu } from "../../components/ui/Menu";
import { saveDownload } from "../../solus/browser/BrowserPageRequests";

const APPEARANCES = [
  { id: "system", title: "System" },
  { id: "light", title: "Light" },
  { id: "dark", title: "Dark" },
] as const satisfies ReadonlyArray<{ id: BrowserAppearance; title: string }>;

/** One preset of each kind, as T3 offers, from the host's own catalog. */
const PRESETS = (["phone", "tablet", "desktop"] as const).flatMap((group) => {
  const preset = DEVICE_PRESETS.find((candidate) => candidate.group === group);
  return preset
    ? [
        {
          id: `preset:${preset.id}`,
          title: `${group[0]!.toUpperCase()}${group.slice(1)} (${preset.label})`,
          presetId: preset.id,
        },
      ]
    : [];
});

export function BrowserTabMenu({
  hostId,
  page,
  streaming,
  viewerSize,
  onPaste,
}: {
  readonly hostId: string;
  readonly page: BrowserPage;
  readonly streaming: boolean;
  /** The viewer's CSS size: "Fit to screen" asks the page to take it. */
  readonly viewerSize: { readonly width: number; readonly height: number } | null;
  readonly onPaste?: () => void;
}) {
  const { browserPageId } = page;
  const viewportId =
    page.viewport.mode === "preset" ? `preset:${page.viewport.presetId}` : page.viewport.mode;
  const zoomFactor = browserZoomOf(page);
  const downloads = [...(page.downloads ?? [])].reverse();

  const closeAction: MenuAction = {
    id: "close",
    title: "Close tab",
    image: "xmark",
    attributes: { destructive: true },
  };
  const actions: MenuAction[] = [
    ...(onPaste ? [{ id: "paste", title: "Paste", image: "doc.on.clipboard" }] : []),
    { id: "hard-reload", title: "Hard reload", image: "arrow.clockwise.circle" },
    {
      id: "appearance",
      title: "Appearance",
      image: "circle.lefthalf.filled",
      subactions: APPEARANCES.map((option) => ({
        id: `appearance:${option.id}`,
        title: option.title,
        state: option.id === page.appearance ? "on" : "off",
      })),
    },
    {
      id: "zoom",
      title: `Zoom (${Math.round(zoomFactor * 100)}%)`,
      image: "plus.magnifyingglass",
      subactions: [
        {
          id: "zoom:in",
          title: "Zoom in",
          image: "plus.magnifyingglass",
          attributes: { disabled: stepBrowserZoom(zoomFactor, 1) === zoomFactor },
        },
        {
          id: "zoom:out",
          title: "Zoom out",
          image: "minus.magnifyingglass",
          attributes: { disabled: stepBrowserZoom(zoomFactor, -1) === zoomFactor },
        },
        {
          id: "zoom:reset",
          title: "Actual size",
          image: "1.magnifyingglass",
          attributes: { disabled: zoomFactor === 1 },
        },
      ],
    },
    {
      id: "viewport",
      title: "Viewport",
      image: "rectangle.and.arrow.up.right.and.arrow.down.left",
      subactions: [
        {
          id: "viewport:fill",
          title: "Fit to screen",
          state: viewportId === "fill" ? "on" : "off",
          attributes: { disabled: viewerSize === null },
        },
        ...PRESETS.map((option) => ({
          id: `viewport:${option.id}`,
          title: option.title,
          state: option.id === viewportId ? ("on" as const) : ("off" as const),
        })),
      ],
    },
    ...(downloads.length > 0
      ? [
          {
            id: "downloads",
            title: "Downloads",
            image: "arrow.down.circle",
            subactions: downloads.map((download) => ({
              id: `download:${download.downloadId}`,
              title: download.fileName,
            })),
          },
        ]
      : []),
    closeAction,
  ];

  const run = (label: string, change: () => Promise<void>) =>
    void change().catch((cause: unknown) =>
      Alert.alert(label, cause instanceof Error ? cause.message : undefined),
    );
  const close = (force: boolean) =>
    run("Could not close this browser tab", async () => {
      const result = await app.browser.close(hostId, browserPageId, force);
      if (result.closed) return;
      // The host judges agent use at the moment of the close; the refusal names the work.
      Alert.alert("An agent is using this page", `Closing it stops ${result.agentUse.verb}.`, [
        { text: "Keep open", style: "cancel" },
        { text: "Close anyway", style: "destructive", onPress: () => close(true) },
      ]);
    });

  const onAction = (id: string) => {
    if (id === "close") return close(false);
    if (id === "paste") return onPaste?.();
    if (id === "hard-reload")
      return run("Could not reload the page", () =>
        app.browser.navigate(hostId, browserPageId, { kind: "reload", ignoreCache: true }),
      );
    if (id.startsWith("zoom:")) {
      const next =
        id === "zoom:in"
          ? stepBrowserZoom(zoomFactor, 1)
          : id === "zoom:out"
            ? stepBrowserZoom(zoomFactor, -1)
            : 1;
      return run("Could not zoom the page", () => app.browser.setZoom(hostId, browserPageId, next));
    }
    if (id.startsWith("download:")) {
      const download = downloads.find((candidate) => `download:${candidate.downloadId}` === id);
      if (download)
        void saveDownload((host, file) => app.browser.downloadUrl(host, file), hostId, download);
      return;
    }
    if (id.startsWith("appearance:")) {
      const option = APPEARANCES.find((candidate) => `appearance:${candidate.id}` === id);
      if (option)
        run("Could not change this browser tab", () =>
          app.browser.setAppearance(hostId, browserPageId, option.id),
        );
      return;
    }
    if (!id.startsWith("viewport:")) return;
    const preset = PRESETS.find((candidate) => `viewport:${candidate.id}` === id);
    const request: BrowserViewportRequest | null = preset
      ? { mode: "preset", presetId: preset.presetId }
      : id === "viewport:fill" && viewerSize
        ? { mode: "fill", width: viewerSize.width, height: viewerSize.height }
        : null;
    if (request)
      run("Could not change the viewport", () =>
        app.browser.setViewport(hostId, browserPageId, request),
      );
  };

  return (
    <ControlPillMenu
      // Remount when streaming changes, so an open menu never keeps offering the other state's actions.
      key={streaming ? "streaming" : "idle"}
      accessible
      accessibilityLabel="Browser tab options"
      accessibilityRole="button"
      isAnchoredToRight
      actions={streaming ? actions : [closeAction]}
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
    >
      <ControlPill icon="ellipsis" accessibilityLabel="Browser tab options" />
    </ControlPillMenu>
  );
}
