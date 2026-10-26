<script lang="ts">
  import { Scale as AttentionIcon } from "@lucide/svelte";
  import GithubMarkdown from '../../github-markdown/GithubMarkdown.svelte';
  import type { GuideSection } from "@solus/contracts/review";
  import { attentionLabel } from "./lib/guide-data";

  // The "why" column of a guide section: the agent's explanation, then the one
  // call the reviewer must make here, when the section has one.
  let { section }: { section: GuideSection } = $props();
</script>

<div class="flex flex-col gap-3.5">
  <div class="prose text-[length:inherit] text-(--solus-text-secondary)">
    <GithubMarkdown source={section.explanation} policy="local" />
  </div>

  {#if section.attention}
    <div
      class="flex items-start gap-2 rounded-lg border border-(--solus-accent-border) bg-(--solus-accent-wash) px-3 py-2.5"
    >
      <AttentionIcon size={16} class="mt-0.5 shrink-0 text-(--solus-accent)" />
      <div class="flex min-w-0 flex-col gap-0.5">
        <p class="font-medium text-(--solus-text-primary)">{attentionLabel(section.attention.kind)}</p>
        <p class="leading-relaxed text-(--solus-text-secondary)">{section.attention.note}</p>
      </div>
    </div>
  {/if}
</div>
