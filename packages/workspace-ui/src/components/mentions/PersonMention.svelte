<script lang="ts">
  import { personMentionMarkdown, type PersonMention } from "@solus/contracts/mentions";
  import UserChip from "../users/UserChip.svelte";
  import { mentionUser, personStanding } from "./lib/mentions";
  import { getMentionContext } from "./lib/mention-context";

  // A mention as a reader sees it: the member as a chip, by their current name.
  // A person who left the organization reads as the saved name in plain ink.
  let { mention }: { mention: PersonMention } = $props();

  const mentions = getMentionContext();
  const user = $derived(mentionUser(mention, personStanding(mention.userId, mentions.directory())));
  // A copy reads as `@name`. The mention itself rides in the copied HTML, so a
  // paste into a composer is the same mention (`reference-clipboard.ts`).
  const reference = $derived(personMentionMarkdown(mention));
</script>

{#if user}
  <span data-person-ref={mention.userId} data-solus-reference={reference}><span class="solus-token__copy-only">@</span><UserChip {user} /></span>
{:else}
  <span class="text-(--solus-text-tertiary)" data-person-ref={mention.userId} data-solus-reference={reference}>@{mention.name}</span>
{/if}
