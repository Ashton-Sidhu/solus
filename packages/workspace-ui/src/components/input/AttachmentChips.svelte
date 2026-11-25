<script lang="ts">
  import FileIcon from "../ui/file-icon/FileIcon.svelte";
  import { scale, fly } from 'svelte/transition'
  import { flip } from 'svelte/animate'
  import {
    X as XIcon,
    RotateCw as RotateCwIcon,
    LoaderCircle as LoaderCircleIcon,
  } from "@lucide/svelte";
  import { portal } from '../portal'
  import { useKeybinding, useScope } from '../../lib/keybindings/use-keybinding.svelte'
  import { fileDrag } from '../../lib/file-drag'
  import { attachmentDownloadName } from '../conversation/lib/attachment-download'
  import { hostImageSources } from '../conversation/lib/host-image-src.svelte'
  import { serverConnections } from '@solus/client-core/server-connections'
  import { videoAttachmentPath } from '../../lib/video-attachment'
  import { requestFilePreview } from '../../lib/filePreview'
  import { attachmentLabel } from '../../lib/attachment-label'
  import { browserMarkChips } from '../../lib/browser-annotation'
  import MarkChip from '../browser/MarkChip.svelte'
  import VideoAttachmentChip from './VideoAttachmentChip.svelte'
  import { HostVideoPlayer } from '../ui/video-player'
  import { isVideoAttachment } from '../../lib/video-attachment'
  import type { HostMediaRequest } from '../../lib/host-media-url.svelte'
  import { attachmentUploads } from './lib/attachment-uploads.svelte'
  import { uploadProgressPercent } from './lib/attachment-upload'
  import { resourceAttachments } from '../../contexts'
  import type { Attachment } from '@solus/contracts/types'

  interface Props {
    attachments: Attachment[]
    tabId?: string
    onRemove: (id: string) => void
    /** Drop one mark from a browser annotation. A chip is one mark, so the row
     *  needs a way to remove a mark that is not "remove everything I marked". */
    onRemoveMark?: (attachmentId: string, markId: string) => void
    onOpen?: (id: string) => void
    /** The composer's host for media bytes that are stored there. */
    host?: Pick<HostMediaRequest, 'serverId' | 'ctx'>
  }

  let { attachments, tabId, onRemove, onRemoveMark, onOpen, host }: Props = $props()

  let previewSrc = $state<string | null>(null)
  let previewVideo = $state<{ request: HostMediaRequest; label: string } | null>(null)

  $effect(() => {
    if (!host) return
    for (const attachment of attachments) {
      if (attachment.needsReattach) continue
      if (attachment.type !== 'image' || attachment.dataUrl || !attachment.hostPath) continue
      const serverId = attachment.hostServerId ?? host.serverId
      hostImageSources.request({
        hostPath: attachment.hostPath,
        serverId,
        origin: serverConnections.httpOriginFor(serverId),
        api: serverConnections.apiFor(serverId),
        ctx: host.ctx,
      })
    }
  })

  $effect(() => {
    for (const missing of attachments.filter((attachment) => attachment.needsReattach)) {
      if (attachments.some((attachment) =>
        attachment.id !== missing.id && attachment.name === missing.name &&
        attachment.type === missing.type && !attachment.needsReattach && !attachmentUploads.stateFor(attachment.id),
      )) removeAttachment(missing.id)
    }
  })

  function imageSource(attachment: Attachment): string | undefined {
    if (attachment.dataUrl) return attachment.dataUrl
    if (attachment.type !== 'image' || !attachment.hostPath || !host) return undefined
    const state = hostImageSources.stateFor(attachment.hostServerId ?? host.serverId, attachment.hostPath)
    return state.status === 'ready' ? state.url : undefined
  }

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


</script>


{#if attachments.length > 0}
  <!-- The row wraps; it never scrolls. A chip pushed off the end of a scroller
       is an attachment the user cannot see they are about to send. -->
  <div class="flex flex-wrap gap-1.5">
    {#each attachments as a (a.id)}
      {@const label = attachmentLabel(a)}
      {@const upload = attachmentUploads.stateFor(a.id)}
      {@const imageSrc = a.needsReattach ? undefined : imageSource(a)}
      {@const isAnnotation = a.type === 'design-selection'}
      {@const isVideo = !a.needsReattach && !!host && isVideoAttachment(a)}
      {@const marks = isAnnotation ? browserMarkChips(a) : []}
      {@const resourceIcon = resourceAttachments.chipIcon(a.id)}
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
          : imageSrc
            ? "relative size-14 flex-shrink-0"
            : "flex h-[1.875rem] max-w-[12.5rem] flex-shrink-0 items-center gap-1.5 rounded-lg border-[0.5px] border-(--solus-container-border) bg-(--solus-input-pill-bg) pr-1.5 pl-2 text-workspace-chrome text-(--solus-text-secondary)"}
      >
        {#if a.needsReattach}
          <span class="min-w-0 truncate text-(--destructive)" title="Attach this file again or remove it.">
            {label} · Attach again
          </span>
          <button
            type="button"
            onclick={() => removeAttachment(a.id)}
            aria-label="Remove {label}"
            class="flex size-4 shrink-0 items-center justify-center rounded focus-visible:ring-2"
          >
            <XIcon size={11} />
          </button>
        {:else if isAnnotation}
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
                <XIcon size={10} strokeWidth={1.5} />
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
              : upload?.status === 'uploading' && imageSrc ? `Uploading ${label}`
              : imageSrc ? `Preview ${label}` : `Open ${label}`}
            use:fileDrag={() => {
              const path = videoAttachmentPath(a)
              return a.type === 'file' && !upload && host && path
                ? { ...host, serverId: a.hostServerId ?? host.serverId, path, name: attachmentDownloadName(a) }
                : null
            }}
            aria-busy={upload?.status === 'uploading'}
            title={upload?.status === 'failed' ? upload.message : undefined}
            class={imageSrc
              ? "size-full overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent)"
              : "flex min-w-0 flex-1 items-center gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--solus-accent)"}
            style="cursor:{imageSrc ? 'zoom-in' : 'pointer'};background:none;border:none;padding:0"
            onclick={() => {
              if (upload?.status === 'failed') attachmentUploads.retry(a.id)
              else if (upload) return
              else if (imageSrc) previewSrc = imageSrc
              else if (onOpen) onOpen(a.id)
              else requestFilePreview({ path: a.hostPath ?? a.path, tabId })
            }}
          >
            {#if imageSrc}
              <img
                src={imageSrc}
                alt={label}
                class="size-full rounded-lg object-cover outline-[0.5px] -outline-offset-1 outline-black/20 dark:outline-white/20 {upload?.status === 'uploading' ? 'opacity-50' : ''}"
              />
              {#if upload?.status === 'uploading'}
                <span class="absolute inset-0 flex items-center justify-center text-white drop-shadow">
                  <LoaderCircleIcon size={16} class="motion-safe:animate-spin" />
                </span>
              {/if}
            {:else}
              <span class="flex-shrink-0 {upload?.status === 'failed' ? 'text-(--destructive)' : 'text-(--solus-text-tertiary)'}">
                {#if upload?.status === 'failed'}<RotateCwIcon size={14} />
                {:else if resourceIcon}<img src={resourceIcon.src} alt={resourceIcon.serverName} title={resourceIcon.serverName} loading="lazy" referrerpolicy="no-referrer" class="size-3.5 rounded-[0.1875rem] bg-white object-contain" />
                {:else}<FileIcon path={a.name} size={14} />{/if}
              </span>
              <span class="min-w-0 flex-1 truncate font-normal">
                {label}
              </span>
              {#if upload?.status === 'uploading' && upload.totalBytes > 0}
                <span class="flex-shrink-0 tabular-nums text-(--solus-text-tertiary)">
                  {uploadProgressPercent(upload.loadedBytes, upload.totalBytes)}%
                </span>
              {:else if upload?.status === 'uploading'}
                <!-- The host reads it (an MCP resource): no byte count to show. -->
                <LoaderCircleIcon size={12} class="flex-shrink-0 text-(--solus-text-tertiary) motion-safe:animate-spin" />
              {/if}
            {/if}
          </button>

          <button
            type="button"
            onclick={() => removeAttachment(a.id)}
            aria-label="Remove {label}"
            class={imageSrc
              ? "absolute top-0 right-0 flex size-4 items-center justify-center rounded-full bg-black/60 text-white shadow-sm transition-[background-color,scale] duration-[var(--duration-quick)] hover:bg-black/80 focus-visible:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:scale-[0.96]"
              : "flex size-4 flex-shrink-0 items-center justify-center rounded text-(--solus-text-tertiary) opacity-60 transition-[background-color,color,opacity,scale] duration-[var(--duration-quick)] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) hover:opacity-100 focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:outline-none active:scale-[0.96]"}
          >
            <XIcon size={imageSrc ? 10 : 11} />
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
      class="fixed inset-0 z-[9999] flex items-center justify-center modal-backdrop p-4"
      transition:fly={{ duration: 150 }}
    >
      <!-- Focus moves into the dialog, so Tab reaches the player's controls. -->
      <button
        type="button"
        {@attach (el) => el.focus()}
        onclick={(e) => { e.stopPropagation(); closePreview() }}
        class="absolute top-4 right-4 flex size-9 items-center justify-center rounded-full bg-white/15 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white pointer-coarse:tap-area"
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
