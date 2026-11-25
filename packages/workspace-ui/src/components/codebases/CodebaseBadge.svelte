<script lang="ts">
  /** The badge of a codebase (docs/plans/codebases.md §9, "Badge"): its
   *  letters or emoji on its colour, on a second card, so it reads as more
   *  than one project. The parent sets the size. */
  import { FolderGit2 as CodebaseIcon } from "@lucide/svelte";
  import type { CodebaseMark } from "@solus/contracts/codebase-badge";
  import { CODEBASE_BADGE_STYLES } from "../../lib/codebase-badge-styles";

  let { mark }: { mark: CodebaseMark } = $props();
  const styles = $derived(CODEBASE_BADGE_STYLES[mark.color]);
</script>

{#if mark.emoji || mark.letters}
  <span class="relative size-full" aria-hidden="true">
    <span class="absolute top-0 right-0 size-[80%] rounded-[22%] {styles.card}"></span>
    <span class="absolute bottom-0 left-0 flex size-[80%] items-center justify-center rounded-[22%] [container-type:size] {styles.badge}">
      {#if mark.emoji}
        <span class="text-[length:70cqh] leading-none">{mark.emoji}</span>
      {:else}
        <!-- Sized against the card, so one badge reads at 13px and at 48px;
             trimmed to its capitals so flex centres the ink, not the line box. -->
        <span class="text-[length:52cqh] leading-none font-bold tracking-tight [text-box:trim-both_cap_alphabetic]">{mark.letters}</span>
      {/if}
    </span>
  </span>
{:else}
  <CodebaseIcon size="100%" class="text-(--solus-text-tertiary)" />
{/if}
