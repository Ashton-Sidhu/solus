import { uploadAttachmentId } from "./upload-attachment-id";
import type {
  ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import type { MessageAttachment } from "@solus-mobile/features/conversation/lib/message-attachments";
import type { UploadedAttachment } from "@solus-mobile/features/conversation/lib/attachments";
import type { DraftComposerAttachment, DraftComposerImageAttachment, DraftComposerFileAttachment } from "../lib/composerImages";
import type { FilePreviewItem } from "../components/ui/FilePreviewModal.types";
import { videoMimeType } from "@solus/contracts/media-types";
import { imageMimeType } from "@t3tools/shared/image";

import type { QueueAttachment } from "@solus/contracts/session-queue";
export function queueChatAttachment(
  a: QueueAttachment,
  resolvePath: (path: string, refresh?: boolean) => Promise<string>,
): ChatAttachment {
  const item = {
    id: a.id,
    name: a.name,
    sizeBytes: a.size ?? 0,
    mimeType: a.mimeType ?? (a.type === "image" ? "image/png" : "application/octet-stream"),
  };
  if (a.type === "image" && (a.dataUrl || a.hostPath)) {
    const image: UploadImage = {
      ...item,
      type: "image",
      preview: a.dataUrl
        ? { uri: a.dataUrl }
        : { path: a.hostPath!, resolveUrl: (refresh) => resolvePath(a.hostPath!, refresh) },
    };
    return image;
  }
  if (a.type === "file" && a.hostPath && videoMimeType(a)) {
    const path = a.hostPath;
    const video: UploadVideo = { ...item, type: "file", mimeType: videoMimeType(a)!, videoPreview: { resolveUrl: refresh => resolvePath(path, refresh) } };
    return video;
  }
  return { ...item, type: a.type };
}
interface UploadImage extends ChatImageAttachment {
  readonly preview:
    | { uri: string }
    | { path: string; resolveUrl: (refresh?: boolean) => Promise<string> };
}
export function isUploadImage(a: ChatAttachment): a is UploadImage {
  return a.type === "image" && "preview" in a;
}

export interface UploadVideo extends ChatFileAttachment {
  readonly videoPreview: { uri: string } | { resolveUrl: (refresh?: boolean) => Promise<string> };
}
export function isUploadVideo(a: ChatAttachment): a is UploadVideo {
  return a.type === "file" && "videoPreview" in a;
}

export function messageAttachments(
  sessionId: string,
  attachments: readonly MessageAttachment[],
  resolvePath: (path: string, refresh?: boolean) => Promise<string>,
): (UploadImage | UploadVideo | ChatFileAttachment)[] {
  return attachments.flatMap((a, index): (UploadImage | UploadVideo | ChatFileAttachment)[] => {
    if (a.kind === "local-video" || (a.kind === "file" && a.video)) {
      return [{ type: "file", id: a.key, name: a.name, sizeBytes: 0,
        mimeType: videoMimeType(a) ?? "video/mp4",
        videoPreview: a.kind === "local-video" ? { uri: a.uri } : { resolveUrl: refresh => resolvePath(a.hostPath, refresh) },
      }];
    }
    if (a.kind === "file") return [{
      type: "file", id: uploadAttachmentId(sessionId,a.hostPath), name:a.name,
      mimeType:a.mimeType ?? "application/octet-stream", sizeBytes:0,
    }];
    const uri = a.kind === "image" ? a.dataUrl : a.kind === "local-image" ? a.uri : null;
    const preview =
      a.kind === "host-image"
        ? { path: a.hostPath, resolveUrl: (refresh?: boolean) => resolvePath(a.hostPath, refresh) }
        : { uri: uri! };
    const mimeType =
      a.mimeType ??
      (uri?.match(/^data:(image\/[^;,]+)/i)?.[1] ||
        imageMimeType({ name: a.name, mimeType: "" }) ||
        "image/*");
    return [
      { type: "image", id: "upload-" + index, name: a.name, mimeType, sizeBytes: 0, preview },
    ];
  });
}

export function uploadImagePreview(
  image: UploadImage,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): FilePreviewItem {
  const meta = { kind: "image" as const, name: image.name, mimeType: image.mimeType };
  return "uri" in image.preview
    ? { ...meta, uri: image.preview.uri }
    : {
        ...meta,
        environmentId,
        resource: { _tag: "media-file", threadId, path: image.preview.path, hostOnly: true },
        resolveUrl: image.preview.resolveUrl,
      };
}

export function composerUploadMedia(
  sessionId: string,
  ready: readonly UploadedAttachment[],
  waiting: readonly DraftComposerImageAttachment[],
  waitingVideos: readonly DraftComposerFileAttachment[],
): DraftComposerAttachment[] {
  return [
    ...ready.flatMap((a): DraftComposerAttachment[] => {
      if (a.kind === "file" && a.localUri) {
        return [{ type: "file", id: a.id, name: a.name, mimeType: a.mimeType, sizeBytes: a.size, fileUri: a.localUri, uploadedAttachmentId:uploadAttachmentId(sessionId, a.hostPath) }];
      }
      const previewUri = a.localUri ?? a.dataUrl;
      if (a.kind !== "image" || !previewUri) return [];
      return [
        {
          type: "image",
          id: a.id,
          name: a.name,
          mimeType: a.mimeType,
          sizeBytes: a.size,
          previewUri,
        },
      ];
    }),
    ...waiting.map((image) => ({ ...image, uploading: true })),
    ...waitingVideos.map((video) => ({ ...video, uploading: true })),
  ];
}
