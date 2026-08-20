<script lang="ts">
  import { scale, fly } from 'svelte/transition'
  import { flip } from 'svelte/animate'
  import {
    X as XIcon,
    FileText as FileTextIcon,
    Image as ImageIcon,
    FileCode as FileCodeIcon,
    File as FileIcon,
    Crosshair as CrosshairIcon,
  } from "@lucide/svelte";
  import { portal } from '../portal'
  import { useKeybinding, useScope } from '../../lib/keybindings/use-keybinding.svelte'
  import { requestFilePreview } from '../../lib/filePreview'
  import { attachmentLabel } from './lib/attachment-label'
  import type { Attachment } from '@solus/contracts/types'
  import type { Component } from 'svelte'

  interface Props {
    attachments: Attachment[]
    tabId?: string
    onRemove: (id: string) => void
    onOpen?: (id: string) => void
  }

  let { attachments, tabId, onRemove, onOpen }: Props = $props()

  let previewSrc = $state<string | null>(null)

  useScope('attachment-preview', { exclusive: true, active: () => !!previewSrc });
  useKeybinding('attachment.close-preview', () => { previewSrc = null; }, { enabled: () => !!previewSrc });

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
  <div class="flex gap-1.5 overflow-x-auto" style="scrollbar-width:none">
    {#each attachments as a (a.id)}
      {@const label = attachmentLabel(a)}
      <div
        animate:flip={{ duration: 150 }}
        in:scale={{ start: 0.85, duration: 120 }}
        out:scale={{ start: 0.85, duration: 120 }}
        class="flex-shrink-0 {a.dataUrl
          ? 'relative size-14 pointer-fine:[.is-laptop-display_&]:size-12'
          : 'flex h-[1.875rem] max-w-[12.5rem] items-center gap-1.5 rounded-lg border-[0.5px] border-(--solus-container-border) bg-(--solus-input-pill-bg) pr-1.5 pl-2 text-workspace-chrome text-(--solus-text-secondary)'}"
      >
        <button
          type="button"
          aria-label={a.dataUrl ? `Preview ${label}` : `Open ${label}`}
          class={a.dataUrl
            ? "size-full overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent) pointer-fine:[.is-laptop-display_&]:rounded-md"
            : "flex min-w-0 flex-1 items-center gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--solus-accent)"}
          style="cursor:{a.dataUrl ? 'zoom-in' : 'pointer'};background:none;border:none;padding:0"
          onclick={() => {
            if (a.dataUrl) previewSrc = a.dataUrl
            else if (onOpen) onOpen(a.id)
            else requestFilePreview({ path: a.hostPath ?? a.path, tabId })
          }}
        >
          {#if a.dataUrl}
            <img
              src={a.dataUrl}
              alt={label}
              class="size-full rounded-lg object-cover outline-[0.5px] -outline-offset-1 outline-black/20 dark:outline-white/20 pointer-fine:[.is-laptop-display_&]:rounded-md"
            />
          {:else}
            {@const IconComponent = FILE_ICON_COMPONENTS[a.mimeType || ''] || FileIcon}
            <span class="flex-shrink-0 text-(--solus-text-tertiary)">
              <IconComponent size={14} />
            </span>
            <span class="min-w-0 flex-1 truncate font-normal">
              {label}
            </span>
          {/if}
        </button>

        <button
          type="button"
          onclick={() => onRemove(a.id)}
          aria-label="Remove {label}"
          class={a.dataUrl
            ? "absolute top-0 right-0 flex size-4 items-center justify-center rounded-full bg-black/60 text-white shadow-sm transition-[background-color,scale] duration-[var(--duration-quick)] hover:bg-black/80 focus-visible:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:scale-[0.96] pointer-fine:[.is-laptop-display_&]:size-3.5"
            : "flex size-4 flex-shrink-0 items-center justify-center rounded text-(--solus-text-tertiary) opacity-60 transition-[background-color,color,opacity,scale] duration-[var(--duration-quick)] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) hover:opacity-100 focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:outline-none active:scale-[0.96]"}
        >
          <XIcon size={a.dataUrl ? 10 : 11} />
        </button>
      </div>
    {/each}
  </div>

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
