<script lang="ts">
  /** The lines under a managed setting: which organizations lock it on this host (plans/030 §7). */
  import { Lock } from "@lucide/svelte";
  import OpenPolicyLink from "./OpenPolicyLink.svelte";
  import type { ManagedSettingNote } from "./lib/managed-setting-note";

  let { note }: { note: ManagedSettingNote } = $props();
</script>

{#if note.lines.length > 0}
  <div class="space-y-0.5 text-[13px] leading-[1.45] text-(--solus-text-secondary)">
    {#each note.lines as line (line)}
      <p class="flex items-start gap-1.5 text-pretty">
        <Lock class="mt-0.5 size-3.5 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
        <span>{line}</span>
      </p>
    {/each}
    <p class="pl-5"><OpenPolicyLink /></p>
  </div>
{/if}
