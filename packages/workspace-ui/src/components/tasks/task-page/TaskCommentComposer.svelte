<script lang="ts">
  import { ArrowUp as ArrowUpIcon } from "@lucide/svelte";
  import { CommentPostingBar } from "../../ui/comment-posting-bar";

  interface Props {
    onSubmit: (body: string) => Promise<void>;
    /** The provider the comment is posted to, as a person reads it. */
    providerName: string;
    /** Overrides for the bar's own stickiness. The page pins the whole bottom
     *  bar at the stacked rung, so the composer must stop pinning itself. */
    class?: string;
    /** The bar shares its row with two 44px controls. "Comment" spelled out
     *  costs about a hundred of the ~250px that leaves, which wrapped the
     *  placeholder onto a second line and made a 48px pill 90px tall — so the
     *  send becomes the arrow it already is everywhere else on a phone. */
    compact?: boolean;
    /** Names the task, the way the spec's pill does: what you are commenting
     *  on is worth stating where the section header is a tab you are not on. */
    placeholder?: string;
  }

  let {
    onSubmit,
    providerName,
    class: className,
    compact = false,
    placeholder = "Leave a comment…",
  }: Props = $props();

  let draft = $state("");
  let posting = $state(false);

  async function send(body: string) {
    posting = true;
    try {
      await onSubmit(body);
    } finally {
      posting = false;
    }
  }
</script>

{#snippet sendIcon()}
  <ArrowUpIcon size={15} aria-hidden="true" />
{/snippet}

<!-- Sticky over the scroll region, with a scrim so rows dissolve into the canvas
     rather than being clipped by a hard edge. The pill itself matches the PR
     composer: one row that grows with the text, the send affordance a tinted
     accent square rather than a footer bar of chrome. Each comment is a
     provider comment, so the send control names where it goes. -->
<CommentPostingBar
  value={draft}
  onValueChange={(value) => (draft = value)}
  onSubmit={send}
  disabled={posting}
  {placeholder}
  submitLabel={posting ? "Posting…" : `Comment on ${providerName}`}
  class={className}
  submitContent={compact ? sendIcon : undefined}
/>
