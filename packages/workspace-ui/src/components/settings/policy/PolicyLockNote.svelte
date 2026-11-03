<script lang="ts">
  /** One lock's words, such as "Remote access is managed by Globex.", and the way to its policy. */
  import { Lock } from "@lucide/svelte";
  import OpenPolicyLink from "./OpenPolicyLink.svelte";

  let { message, class: className = "" }: { message: string; class?: string } = $props();
</script>

<p class="flex flex-wrap items-start gap-x-1.5 gap-y-0.5 text-pretty text-[13px] leading-[1.45] text-(--solus-text-secondary) {className}">
  <Lock class="mt-0.5 size-3.5 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
  <span class="min-w-0">{message}</span>
  <OpenPolicyLink />
</p>
