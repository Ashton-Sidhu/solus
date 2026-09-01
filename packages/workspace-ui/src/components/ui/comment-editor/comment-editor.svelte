<script lang="ts">
  import { onDestroy } from "svelte";
  import { uuid } from "@solus/contracts/uuid";
  import type { Attachment } from "@solus/contracts/types";
  import {
    assetFileMarkdown,
    assetImageMarkdown,
    attachmentFilesFromDataTransfer,
    isInlineAssetImage,
    uploadAsset,
  } from "../../../lib/asset-upload";
  import { getMarkdownImageContext } from "../../conversation/lib/markdown-image";
  import AttachmentChips from "../../input/AttachmentChips.svelte";
  import PlainTextEditor from "../plain-text-editor/plain-text-editor.svelte";

  interface Props {
    value: string;
    onValueChange: (value: string) => void;
    onInput?: () => void;
    onEmptyChange?: (empty: boolean) => void;
    onUploadStateChange?: (isUploading: boolean) => void;
    onKeyDown?: (event: KeyboardEvent) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    placeholder?: string;
    ariaLabel?: string;
    disabled?: boolean;
    mic?: boolean;
    maxHeight?: number;
    class?: string;
    style?: string;
  }

  let {
    value,
    onValueChange,
    onInput,
    onEmptyChange,
    onUploadStateChange,
    onKeyDown,
    onFocus,
    onBlur,
    placeholder = "",
    ariaLabel,
    disabled = false,
    mic = true,
    maxHeight = 160,
    class: klass = "",
    // Comment inputs use the compact content rung. The submitted prose can be
    // larger, but the placeholder and typed text should not outweigh the
    // adjacent avatar and send control.
    style = "--plain-editor-font-size:var(--text-caption);--plain-editor-line-height:1.25rem",
  }: Props = $props();

  let editor: ReturnType<typeof PlainTextEditor> | null = $state(null);
  const imageContext = getMarkdownImageContext();

  interface Preview extends Attachment {
    markdown?: string;
    objectUrl: string;
  }

  let previews = $state<Preview[]>([]);
  let uploadCount = $state(0);
  let uploadError = $state("");

  function removePreview(previewId: string) {
    const index = previews.findIndex((preview) => preview.id === previewId);
    if (index < 0) return;
    const preview = previews[index];
    URL.revokeObjectURL(preview.objectUrl);
    previews.splice(index, 1);
    onEmptyChange?.(value.trim().length === 0 && previews.length === 0);
  }

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    const api = imageContext?.api();
    if (!api) {
      uploadError = "This host cannot store attachments here.";
      return;
    }

    uploadError = "";
    uploadCount += files.length;
    onUploadStateChange?.(true);
    for (const file of files) {
      const isImage = isInlineAssetImage(file);
      const objectUrl = URL.createObjectURL(file);
      const preview: Preview = {
        id: uuid(),
        type: isImage ? "image" : "file",
        name: file.name || "attachment",
        path: file.name || "attachment",
        mimeType: file.type,
        size: file.size,
        dataUrl: isImage ? objectUrl : undefined,
        objectUrl,
      };
      previews.push(preview);
      onEmptyChange?.(false);
      try {
        const asset = await uploadAsset(api, file);
        const markdown = isImage
          ? assetImageMarkdown(preview.name, asset.uri)
          : assetFileMarkdown(preview.name, asset.uri);
        preview.markdown = markdown;
      } catch (error) {
        uploadError = error instanceof Error
          ? error.message
          : "Unable to store the attachment.";
        removePreview(preview.id);
      } finally {
        uploadCount -= 1;
        if (uploadCount === 0) onUploadStateChange?.(false);
      }
    }
  }

  function handlePaste(event: ClipboardEvent) {
    const files = attachmentFilesFromDataTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }

  function handleDrop(event: DragEvent) {
    const files = attachmentFilesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }

  onDestroy(() => {
    for (const preview of previews) {
      URL.revokeObjectURL(preview.objectUrl);
    }
  });

  export function focus() {
    editor?.focus();
  }

  /** For a host that renders the recorder itself rather than in the field. */
  export function insertTranscript(transcript: string) {
    editor?.insertTranscript(transcript);
  }

  export function getMarkdown(): string {
    return [
      value.trim(),
      ...previews.map((preview) => preview.markdown ?? ""),
    ].filter(Boolean).join("\n\n");
  }

  export function isEmpty(): boolean {
    return value.trim().length === 0 && previews.length === 0;
  }

  export function isUploading(): boolean {
    return uploadCount > 0;
  }

  export function clear() {
    for (const preview of previews) {
      URL.revokeObjectURL(preview.objectUrl);
    }
    previews.splice(0, previews.length);
    uploadError = "";
    editor?.clearEditor();
    onEmptyChange?.(true);
  }
</script>

<div class="flex min-w-0 flex-1 flex-col gap-2 {klass}">
  {#if previews.length > 0}
    <AttachmentChips
      attachments={previews}
      onRemove={removePreview}
      onOpen={(previewId) => {
        const preview = previews.find((item) => item.id === previewId);
        if (preview) window.open(preview.objectUrl, "_blank", "noopener,noreferrer");
      }}
    />
  {/if}
  {#if uploadCount > 0 || uploadError}
    <span class="text-xs {uploadError ? 'text-destructive' : 'text-muted-foreground'}">
      {uploadError || "Adding attachment…"}
    </span>
  {/if}
  <PlainTextEditor
    bind:this={editor}
    {value}
    {onValueChange}
    {onInput}
    {onEmptyChange}
    {onKeyDown}
    onPaste={handlePaste}
    onDrop={handleDrop}
    {onFocus}
    {onBlur}
    {placeholder}
    {ariaLabel}
    {disabled}
    {mic}
    micPlacement="beside"
    {maxHeight}
    enterInsertsNewline
    {style}
  />
</div>
