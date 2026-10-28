import { SymbolView } from "./AppSymbol";
import { Image } from "expo-image";
import { memo, useLayoutEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { hostPathBaseName } from "@solus/contracts/host-path";
import { projectBadgeColors, projectInitials } from "@solus/contracts/project-badge";
import { useApp, useListened } from "../app/app-context";
import { AppText as Text } from "./AppText";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useProjectFaviconUrl } from "../lib/project-favicon-url";

import {
  beginProjectFaviconRequest,
  createProjectFaviconRequest,
  hasLoadedProjectFavicon,
  markProjectFaviconFailed,
  markProjectFaviconLoaded,
} from "../lib/projectFaviconRequests";

/* ─── Component ──────────────────────────────────────────────────────── */
export const ProjectFavicon = memo(function ProjectFavicon(props: {
  /** The Solus host the project lives on. */
  readonly environmentId: string;
  /** A chat has no project: it shows a chat bubble, not a folder. */
  readonly chat?: boolean;
  readonly open?: boolean;
  readonly size?: number;
  readonly projectTitle: string;
  readonly workspaceRoot?: string | null;
}) {
  const size = props.size ?? 42;
  // The project's host serves its favicon; without one the folder stays.
  const app = useApp();
  const connectedGeneration = useListened(app.connections.changes, () => {
    const state = app.connections.state(props.environmentId);
    return state?.readiness === "ready" ? state.sessionGeneration : null;
  });
  const renderableFaviconUrl = useProjectFaviconUrl(
    props.workspaceRoot ? app.connections.connection(props.environmentId) : null,
    props.workspaceRoot ?? null,
    connectedGeneration,
  );
  const cacheKey = useMemo(
    () => (props.workspaceRoot ? `${props.environmentId}:${props.workspaceRoot}` : null),
    [props.environmentId, props.workspaceRoot],
  );

  return (
    <ProjectFaviconImage
      key={cacheKey}
      cacheKey={cacheKey}
      chat={props.chat}
      faviconUrl={renderableFaviconUrl}
      open={props.open}
      projectTitle={props.projectTitle}
      badgeName={(props.workspaceRoot && hostPathBaseName(props.workspaceRoot)) || props.projectTitle}
      size={size}
    />
  );
});

function ProjectFaviconImage(props: {
  readonly cacheKey: string | null;
  readonly chat?: boolean;
  readonly faviconUrl: string | null;
  readonly open?: boolean;
  readonly projectTitle: string;
  /** The folder's name, as desktop and web name the badge. */
  readonly badgeName: string;
  readonly size: number;
}) {
  const faviconRequest = useMemo(
    () => createProjectFaviconRequest(props.cacheKey, props.faviconUrl),
    [props.cacheKey, props.faviconUrl],
  );
  const [activeFaviconRequest, setActiveFaviconRequest] = useState<typeof faviconRequest>(null);
  useLayoutEffect(() => {
    if (faviconRequest === null) return;

    const endRequest = beginProjectFaviconRequest(faviconRequest);
    setActiveFaviconRequest(faviconRequest);
    return endRequest;
  }, [faviconRequest]);

  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    props.faviconUrl?.startsWith("data:") || hasLoadedProjectFavicon(props.cacheKey)
      ? "loaded"
      : "loading",
  );

  const requestIsActive = faviconRequest !== null && activeFaviconRequest === faviconRequest;
  const { themeAppearance } = useAppearancePreferences();
  const initials = projectInitials(props.badgeName);
  const badge = projectBadgeColors(props.badgeName, themeAppearance === "dark" ? "dark" : "light");
  const showImage = requestIsActive && status === "loaded";

  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* No favicon: the project's initials on its own colour, as on desktop and
          web. A chat shows a bubble, and a name with no letters a folder. */}
      {!showImage && !props.chat && initials ? (
        <View
          style={{
            width: props.size,
            height: props.size,
            borderRadius: props.size * 0.22,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: badge.background,
          }}
        >
          <Text
            allowFontScaling={false}
            style={{ color: badge.foreground, fontSize: props.size * 0.48, fontWeight: "600", lineHeight: props.size * 0.6 }}
          >
            {initials}
          </Text>
        </View>
      ) : !showImage ? (
        <SymbolView
          name={
            props.chat
              ? { ios: "bubble.left.fill", android: "chat_bubble" }
              : { ios: "folder.fill", android: props.open ? "folder_open" : "folder" }
          }
          size={props.size}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
        />
      ) : null}

      {/* Favicon image (hidden until loaded) */}
      {requestIsActive ? (
        <Image
          key={faviconRequest.faviconUrl}
          source={
            faviconRequest.faviconUrl.startsWith("data:")
              ? { uri: faviconRequest.faviconUrl }
              : { uri: faviconRequest.faviconUrl, cacheKey: faviconRequest.cacheKey }
          }
          cachePolicy={faviconRequest.faviconUrl.startsWith("data:") ? "memory" : "memory-disk"}
          recyclingKey={faviconRequest.cacheKey}
          accessibilityLabel={`${props.projectTitle} favicon`}
          style={{
            width: props.size,
            height: props.size,
            borderRadius: props.size * 0.16,
            ...(showImage ? {} : { position: "absolute" as const, opacity: 0 }),
          }}
          contentFit="contain"
          onLoad={() => {
            if (!markProjectFaviconLoaded(faviconRequest)) return;
            setStatus("loaded");
          }}
          onError={() => {
            if (!markProjectFaviconFailed(faviconRequest)) return;
            setStatus("error");
          }}
        />
      ) : null}
    </View>
  );
}
