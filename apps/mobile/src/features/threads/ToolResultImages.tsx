import type { ToolResultImage } from "@solus/contracts/types";
import { memo, useState } from "react";
import { ActivityIndicator, Image, Pressable, View } from "react-native";

import { useApp } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { FilePreview, type ResolvedFilePreviewSource } from "../../components/FilePreview";
import type { ConversationStore } from "../conversation/conversation-store";
import { useHostMediaUrl } from "../files/host-media-url";
import type { HostConnection } from "../hosts/host-connections";

/** Tall enough to read a phone screenshot, short enough to keep the work log a log. */
const FRAME_HEIGHT = 200;
const FRAME_RADIUS = 10;

function ToolImage(props: {
  readonly connection: HostConnection | null;
  readonly image: ToolResultImage;
  readonly name: string;
  readonly onPressPreview: (source: ResolvedFilePreviewSource) => void;
}) {
  const { state } = useHostMediaUrl(props.connection, { assetId: props.image.assetId });
  // The host sends the pixel size, so the frame holds its shape before the picture loads.
  const aspectRatio = props.image.width && props.image.height ? props.image.width / props.image.height : 4 / 3;
  const frame = { height: FRAME_HEIGHT, aspectRatio, maxWidth: "100%" as const, borderRadius: FRAME_RADIUS };
  if (state.kind !== "ready") {
    return (
      <View
        accessible
        accessibilityLabel={state.kind === "failed" ? `${props.name} is unavailable` : `Loading ${props.name}`}
        className="items-center justify-center bg-subtle"
        style={frame}
      >
        {state.kind === "failed" ? (
          <SymbolView name="photo" size={20} tintColorClassName="accent-icon-muted" type="monochrome" />
        ) : (
          <ActivityIndicator />
        )}
      </View>
    );
  }
  const uri = state.url;
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open ${props.name}`}
      onPress={() => props.onPressPreview({ kind: "image", uri, name: props.name })}
    >
      <Image source={{ uri }} className="bg-subtle" style={frame} resizeMode="contain" />
    </Pressable>
  );
}

/** The pictures a tool call returned, in its expanded work-log row. Each loads
 *  from the host asset store through a signed URL; a tap opens the preview. */
export const ToolResultImages = memo(function ToolResultImages(props: {
  readonly images: readonly ToolResultImage[];
  readonly label: string;
  readonly store: ConversationStore;
}) {
  const app = useApp();
  const [preview, setPreview] = useState<ResolvedFilePreviewSource | null>(null);
  const connection = app.connections.connection(props.store.controller.hostId);
  return (
    <View className="flex-row flex-wrap gap-2 pb-1 pt-0.5">
      {props.images.map((image, index) => (
        <ToolImage
          key={index}
          connection={connection}
          image={image}
          name={props.images.length > 1 ? `${props.label} (${index + 1} of ${props.images.length})` : props.label}
          onPressPreview={setPreview}
        />
      ))}
      {preview ? <FilePreview source={preview} onRequestClose={() => setPreview(null)} /> : null}
    </View>
  );
});
