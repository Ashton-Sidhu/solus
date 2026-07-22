<script lang="ts">
  import type { Snippet } from "svelte";
  import { CheckIcon } from "phosphor-svelte";

  interface Props {
    children?: Snippet;
    task?: boolean;
    checked?: boolean;
  }

  let { children, task = false, checked = false }: Props = $props();
</script>

{#if task}
  <li class="markdown-task-item" class:markdown-task-checked={checked}>
    <span class="markdown-task-checkbox" aria-hidden="true">
      {#if checked}<CheckIcon size={11} weight="bold" />{/if}
    </span>
    <span class="sr-only">{checked ? "Completed" : "Not completed"}: </span>
    <div class="markdown-task-content">{@render children?.()}</div>
  </li>
{:else}
  <li>{@render children?.()}</li>
{/if}
