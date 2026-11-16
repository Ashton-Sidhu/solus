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
  // The chip shows a name. A copy keeps the whole mention, so a paste still
  // names the person: the link's target goes after the name as copy-only text.
  const copyTarget = $derived.by(() => {
    const markdown = personMentionMarkdown(mention);
    return markdown.slice(markdown.lastIndexOf("]("));
  });
</script>

{#if user}
  <span data-person-ref={mention.userId}><span class="solus-token__copy-only">[@</span><UserChip {user} /><span class="solus-token__copy-only">{copyTarget}</span></span>
{:else}
  <span class="text-(--solus-text-tertiary)" data-person-ref={mention.userId}><span class="solus-token__copy-only">[</span>@{mention.name}<span class="solus-token__copy-only">{copyTarget}</span></span>
{/if}
