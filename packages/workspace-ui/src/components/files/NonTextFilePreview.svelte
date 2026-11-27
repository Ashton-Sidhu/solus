<script lang="ts">
  import type { IpcContext } from "@solus/contracts/types";
  import FileIcon from "../ui/file-icon/FileIcon.svelte";
  import { HostMediaUrl, type HostMediaRequest } from "../../lib/host-media-url.svelte";
  import { HostVideoPlayer } from "../ui/video-player";
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import DocumentFilePreview from "./DocumentFilePreview.svelte";
  import ImageFilePreview from "./ImageFilePreview.svelte";
  import PdfFilePreview from "./PdfFilePreview.svelte";
  import ZipFilePreview from "./ZipFilePreview.svelte";
  import { formatFileSize, type NonTextFile } from "./lib/non-text-file";
  import { protectedPreviewKind } from "./lib/protected-preview-error";

  interface Props {
    serverId: string;
    ctx?: IpcContext;
    file: NonTextFile;
    title: string;
  }

  let { serverId, ctx, file, title }: Props = $props();

  const binaryPreview = $derived(file.kind === "binary" ? protectedPreviewKind(file.path) : null);

  // Media loads from a URL the host signs, on every client alike. Previewable
  // binary files (ZIP, Office, OpenDocument, EPUB) use a signed checkout download URL.
  const request = $derived<HostMediaRequest | null>(
    file.kind === "media"
      ? { serverId, path: file.path }
      : binaryPreview
        ? { serverId, path: file.path, download: true, ctx }
        : null,
  );
  const media = new HostMediaUrl(() =>
    (file.kind === "media" && file.media.kind !== "video") || binaryPreview !== null ? request : null,
  );
</script>

{#if file.kind === "binary" && !binaryPreview}
  <div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="binary-file-preview">
    <FileIcon path={file.path} size={28} class="text-(--solus-text-tertiary)" />
    <p class="text-workspace-chrome text-(--solus-text-primary)">This file type cannot be shown.</p>
    <p class="text-xs text-(--solus-text-tertiary) tabular-nums">{formatFileSize(file.size)}</p>
  </div>
{:else if file.kind === "media" && file.media.kind === "video"}
  <div class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4" data-testid="video-file-preview">
    <HostVideoPlayer {request} label={title} class="w-full max-w-4xl" />
  </div>
{:else if media.hasFailed}
  <p role="alert" class="m-auto p-6 text-center text-workspace-chrome text-(--solus-status-error)">
    The host could not send this file.
  </p>
{:else if !media.url}
  <ContentSkeleton label="Loading file" preview />
{:else if binaryPreview === "zip"}
  <ZipFilePreview src={media.url} {title} />
{:else if binaryPreview}
  <DocumentFilePreview src={media.url} {title} kind={binaryPreview} />
{:else if file.kind === "media" && file.media.kind === "pdf"}
  <PdfFilePreview src={media.url} {title} />
{:else}
  {#key media.url}
    <ImageFilePreview src={media.url} {title} />
  {/key}
{/if}
