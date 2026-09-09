<script lang="ts">
  import { Check as CheckIcon, Trash2 as TrashIcon } from "@lucide/svelte";

  let {
    selected,
    label,
    onRemove,
  }: {
    selected: boolean;
    label: string;
    onRemove?: () => void;
  } = $props();
</script>

<!-- The parent row owns group/project-row and reserves its trailing slot. -->
<span class="pointer-events-none absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center pointer-coarse:size-9">
  {#if selected}
    <CheckIcon
      size={13}
      class="text-(--solus-accent) {onRemove ? 'group-hover/project-row:opacity-0 group-focus-within/project-row:opacity-0 pointer-coarse:opacity-0' : ''}"
    />
  {/if}
  {#if onRemove}
    <button
      type="button"
      class="pointer-events-auto absolute inset-0 flex items-center justify-center rounded-md text-(--solus-text-tertiary) opacity-0 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100 pointer-coarse:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-(--solus-accent)"
      title="Remove from history"
      aria-label="Remove {label} from history"
      onkeydown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
      onclick={(event) => {
        event.stopPropagation();
        onRemove?.();
      }}
    >
      <TrashIcon size={13} />
    </button>
  {/if}
</span>
