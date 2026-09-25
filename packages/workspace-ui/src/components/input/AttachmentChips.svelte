<script lang="ts">
  import { scale, fly } from 'svelte/transition'
  import { flip } from 'svelte/animate'
  import {
    X as XIcon,
    FileText as FileTextIcon,
    Image as ImageIcon,
    FileCode as FileCodeIcon,
    File as FileIcon,
    RotateCw as RotateCwIcon,
  } from "@lucide/svelte";
  import { portal } from '../portal'
  import { useKeybinding, useScope } from '../../lib/keybindings/use-keybinding.svelte'
  import { requestFilePreview } from '../../lib/filePreview'
  import { attachmentLabel } from './lib/attachment-label'
  import { browserMarkChips } from '../../lib/browser-annotation'
  import MarkChip from '../browser/MarkChip.svelte'
  import VideoAttachmentChip from './VideoAttachmentChip.svelte'
  import { HostVideoPlayer } from '../ui/video-player'
  import { isVideoAttachment } from '../../lib/video-attachment'
  import type { HostMediaRequest } from '../../lib/host-media-url.svelte'
  import { attachmentUploads } from './lib/attachment-uploads.svelte'
  import { uploadProgressPercent } from './lib/attachment-upload'
  import type { Attachment } from '@solus/contracts/types'
  import type { Component } from 'svelte'

  interface Props {
    attachments: Attachment[]
    tabId?: string
    onRemove: (id: string) => void
    /** Drop one mark from a browser annotation. A chip is one mark, so the row
     *  needs a way to remove a mark that is not "remove everything I marked". */
    onRemoveMark?: (attachmentId: string, markId: string) => void
    onOpen?: (id: string) => void
    /** The composer's host. Without it a video shows as a plain file chip. */
    host?: Pick<HostMediaRequest, 'serverId' | 'ctx' | 'canReadLocalFiles'>
  }

  let { attachments, tabId, onRemove, onRemoveMark, onOpen, host }: Props = $props()

  let previewSrc = $state<string | null>(null)
  let previewVideo = $state<{ request: HostMediaRequest; label: string } | null>(null)

  function closePreview() {
    previewSrc = null
    previewVideo = null
  }

  function removeAttachment(attachmentId: string) {
    attachmentUploads.cancel(attachmentId)
    onRemove(attachmentId)
  }

  useScope('attachment-preview', { exclusive: true, active: () => !!previewSrc || !!previewVideo });
  useKeybinding('attachment.close-preview', closePreview, { enabled: () => !!previewSrc || !!previewVideo });

  const FILE_ICON_COMPONENTS = {
    'image/png': ImageIcon,
    'image/jpeg': ImageIcon,
    'image/gif': ImageIcon,
    'image/webp': ImageIcon,
    'image/svg+xml': ImageIcon,
    'text/plain': FileTextIcon,
    'text/markdown': FileTextIcon,
    'application/json': FileCodeIcon,
    'text/yaml': FileCodeIcon,
    'text/toml': FileCodeIcon,
  } satisfies Record<string, Component>

</script>


{#if attachments.length > 0}
  <!-- The row wraps; it never scrolls. A chip pushed off the end of a scroller
       is an attachment the user cannot see they are about to send. -->
  <div class="flex flex-wrap gap-1.5">
    {#each attachments as a (a.id)}
      {@const label = attachmentLabel(a)}
      {@const isAnnotation = a.type === 'design-selection'}
      {@const isVideo = !!host && isVideoAttachment(a)}
      {@const upload = attachmentUploads.stateFor(a.id)}
      {@const marks = isAnnotation ? browserMarkChips(a) : []}
      <!-- One animated root per item (Svelte requires the `animate:` element to
           be the each's only child); the branch lives inside. A browser
           annotation is not one chip: it is one chip per mark, in pin order,
           and each chip is self-contained — the tool, the pin, the element, and
           the page and viewport it was marked up on. There is no second chip. -->
      <div
        animate:flip={{ duration: 150 }}
        in:scale={{ start: 0.85, duration: 120 }}
        out:scale={{ start: 0.85, duration: 120 }}
        class={isAnnotation
          ? "flex min-w-0 flex-wrap items-center gap-1.5"
          : isVideo
            ? "flex-shrink-0"
          : a.dataUrl
            ? "relative size-14 flex-shrink-0"
            : "flex h-[1.875rem] max-w-[12.5rem] flex-shrink-0 items-center gap-1.5 rounded-lg border-[0.5px] border-(--solus-container-border) bg-(--solus-input-pill-bg) pr-1.5 pl-2 text-workspace-chrome text-(--solus-text-secondary)"}
      >
        {#if isAnnotation}
          {#each marks as mark (mark.id)}
            <MarkChip
              chip={mark}
              onRemove={() =>
                onRemoveMark ? onRemoveMark(a.id, mark.id) : onRemove(a.id)}
            />
          {/each}
          {#if marks.length === 0}
            <!-- No marks: an older draft. It still has to be removable. -->
            <button
              type="button"
              onclick={() => onRemove(a.id)}
              class="text-chrome-shelf flex h-6.5 items-center gap-1.5 rounded-lg bg-card pr-[0.1875rem] pl-2 text-(--solus-text-secondary) shadow-[shadow:inset_0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]"
              aria-label="Remove {label}"
            >
              <span class="truncate">{label}</span>
              <span class="flex size-5 shrink-0 items-center justify-center rounded-md opacity-55">
                <XIcon size={10} strokeWidth={2} />
              </span>
            </button>
          {/if}
        {:else if isVideo && host}
          <VideoAttachmentChip
            attachment={a}
            {label}
            {host}
            onRemove={() => onRemove(a.id)}
            onPlay={(request) => (previewVideo = { request, label })}
          />
        {:else}
          <button
            type="button"
            aria-label={upload?.status === 'failed'
              ? `Retry uploading ${label}: ${upload.message}`
              : a.dataUrl ? `Preview ${label}` : `Open ${label}`}
            title={upload?.status === 'failed' ? upload.message : undefined}
            class={a.dataUrl
              ? "size-full overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent)"
              : "flex min-w-0 flex-1 items-center gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--solus-accent)"}
            style="cursor:{a.dataUrl ? 'zoom-in' : 'pointer'};background:none;border:none;padding:0"
            onclick={() => {
              if (upload?.status === 'failed') attachmentUploads.retry(a.id)
              else if (upload) return
              else if (a.dataUrl) previewSrc = a.dataUrl
              else if (onOpen) onOpen(a.id)
              else requestFilePreview({ path: a.hostPath ?? a.path, tabId })
            }}
          >
            {#if a.dataUrl}
              <img
                src={a.dataUrl}
                alt={label}
                class="size-full rounded-lg object-cover outline-[0.5px] -outline-offset-1 outline-black/20 dark:outline-white/20"
              />
            {:else}
              {@const IconComponent =
                upload?.status === 'failed' ? RotateCwIcon : FILE_ICON_COMPONENTS[a.mimeType || ''] || FileIcon}
              <span class="flex-shrink-0 {upload?.status === 'failed' ? 'text-(--destructive)' : 'text-(--solus-text-tertiary)'}">
                <IconComponent size={14} />
              </span>
              <span class="min-w-0 flex-1 truncate font-normal">
                {label}
              </span>
              {#if upload?.status === 'uploading'}
                <span class="flex-shrink-0 tabular-nums text-(--solus-text-tertiary)">
                  {uploadProgressPercent(upload.loadedBytes, upload.totalBytes)}%
                </span>
              {/if}
            {/if}
          </button>

          <button
            type="button"
            onclick={() => removeAttachment(a.id)}
            aria-label="Remove {label}"
            class={a.dataUrl
              ? "absolute top-0 right-0 flex size-4 items-center justify-center rounded-full bg-black/60 text-white shadow-sm transition-[background-color,scale] duration-[var(--duration-quick)] hover:bg-black/80 focus-visible:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:scale-[0.96]"
              : "flex size-4 flex-shrink-0 items-center justify-center rounded text-(--solus-text-tertiary) opacity-60 transition-[background-color,color,opacity,scale] duration-[var(--duration-quick)] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) hover:opacity-100 focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:outline-none active:scale-[0.96]"}
          >
            <XIcon size={a.dataUrl ? 10 : 11} />
          </button>
        {/if}
      </div>
    {/each}
  </div>

  {#if previewVideo}
    <!-- The same lightbox as an image. The player takes its own clicks, so
         only the backdrop closes it; Esc closes it from the keyboard. -->
    <div
      data-solus-ui
      use:portal={document.body}
      onclick={closePreview}
      onkeydown={(e) => { if (e.key === 'Escape') closePreview(); }}
      role="dialog"
      aria-modal="true"
      aria-label={previewVideo.label}
      tabindex="-1"
      class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4"
      transition:fly={{ duration: 150 }}
    >
      <!-- Focus moves into the dialog, so Tab reaches the player's controls. -->
      <button
        type="button"
        {@attach (el) => el.focus()}
        onclick={(e) => { e.stopPropagation(); closePreview() }}
        class="absolute top-4 right-4 flex size-9 items-center justify-center rounded-full bg-white/15 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white pointer-coarse:size-11"
        title="Close (Esc)"
        aria-label="Close preview"
      >
        <XIcon size={18} />
      </button>
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="w-[min(90vw,64rem)]" onclick={(e) => e.stopPropagation()}>
        <HostVideoPlayer request={previewVideo.request} label={previewVideo.label} />
      </div>
    </div>
  {/if}

  {#if previewSrc}
    <div
      data-solus-ui
      use:portal={document.body}
      onclick={() => previewSrc = null}
      onkeydown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') previewSrc = null; }}
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;cursor:zoom-out"
      transition:fly={{ duration: 150 }}
    >
      <button
        onclick={(e) => { e.stopPropagation(); previewSrc = null }}
        style="position:absolute;top:1rem;right:1rem;width:2.25rem;height:2.25rem;border-radius:50%;background:rgba(255,255,255,0.15);border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;backdrop-filter:blur(0.25rem)"
        title="Close (Esc)"
        aria-label="Close preview"
      >
        <XIcon size={18} weight="bold" />
      </button>
      <img
        src={previewSrc}
        style="max-width:90vw;max-height:90vh;border-radius:0.625rem;object-fit:contain;cursor:default;box-shadow:0 0.5rem 2.5rem rgba(0,0,0,0.6)"
        alt="preview"
      />
    </div>
  {/if}
{/if}
