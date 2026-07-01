<script lang="ts">
  import { scale, fly } from 'svelte/transition'
  import { flip } from 'svelte/animate'
  import { XIcon, FileTextIcon, ImageIcon, FileCodeIcon, FileIcon, CrosshairIcon } from 'phosphor-svelte'
  import { portal } from '../portal'
  import { useKeybinding, useScope } from '../../lib/keybindings/use-keybinding.svelte'
  import { requestFilePreview } from '../../lib/filePreview'
  import type { Attachment } from '../../../shared/types'
  import type { Component } from 'svelte'

  interface Props {
    attachments: Attachment[]
    onRemove: (id: string) => void
  }

  let { attachments, onRemove }: Props = $props()

  let previewSrc = $state<string | null>(null)

  useScope('attachment-preview', { exclusive: true, active: () => !!previewSrc });
  useKeybinding('attachment.close-preview', () => { previewSrc = null; }, { enabled: () => !!previewSrc });

  const FILE_ICON_COMPONENTS: Record<string, Component> = {
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
  }

</script>


{#if attachments.length > 0}
  <div class="flex gap-1.5 px-1 pb-1" style="overflow-x:auto;scrollbar-width:none">
    {#each attachments as a (a.id)}
      <div
        animate:flip={{ duration: 150 }}
        in:scale={{ start: 0.85, duration: 120 }}
        out:scale={{ start: 0.85, duration: 120 }}
        class="flex items-center gap-1.5 group flex-shrink-0 bg-(--solus-surface-primary) border border-(--solus-surface-secondary)"
        style="border-radius:0.875rem;padding:{a.dataUrl ? '0.1875rem 0.5rem 0.1875rem 0.1875rem' : '0.25rem 0.5rem'};max-width:12.5rem"
      >
        <button
          class="flex items-center gap-1.5 min-w-0 flex-1"
          style="cursor:{a.dataUrl ? 'zoom-in' : 'pointer'};background:none;border:none;padding:0"
          onclick={() => {
            if (a.dataUrl) previewSrc = a.dataUrl
            else requestFilePreview({ path: a.path })
          }}
        >
          {#if a.type === 'design-selection' && a.dataUrl}
            <img
              src={a.dataUrl}
              alt={a.name}
              class="rounded-[0.625rem] object-cover flex-shrink-0"
              style="width:1.5rem;height:1.5rem;border:0.0938rem solid #FF3B30"
            />
          {:else if a.dataUrl}
            <img
              src={a.dataUrl}
              alt={a.name}
              class="rounded-[0.625rem] object-cover flex-shrink-0"
              style="width:1.5rem;height:1.5rem"
            />
          {:else}
            {@const IconComponent = FILE_ICON_COMPONENTS[a.mimeType || ''] || FileIcon}
            <span class="flex-shrink-0 text-(--solus-text-tertiary)">
              <IconComponent size={14} />
            </span>
          {/if}
          <span class="text-[0.6875rem] font-medium truncate min-w-0 flex-1 text-(--solus-text-primary)">
            {a.name}
          </span>
        </button>

        <button
          onclick={() => onRemove(a.id)}
          class="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-(--solus-text-tertiary)"
        >
          <XIcon size={10} />
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
