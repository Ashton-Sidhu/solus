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
    /** Names the task, the way the spec's pill does: what you are commenting
     *  on is worth stating where the section header is a tab you are not on. */
    placeholder?: string;
  }

  let {
    onSubmit,
    providerName,
    class: className,
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

<!-- Sticky over the scroll region, with a scrim so rows dissolve into the canvas
     rather than being clipped by a hard edge. The pill matches the pull request
     composer: one row that grows with the text, and the send is the same tinted
     arrow square at every width. Each comment is a provider comment, so the
     send's label and tooltip name where it goes. -->
<CommentPostingBar
  value={draft}
  onValueChange={(value) => (draft = value)}
  onSubmit={send}
  disabled={posting}
  {placeholder}
  submitLabel={posting ? "Posting…" : `Comment on ${providerName}`}
  submitAriaLabel={posting ? "Posting comment" : `Post comment on ${providerName}`}
  class={className}
>
  {#snippet submitContent()}
    <ArrowUpIcon size={13} aria-hidden="true" />
  {/snippet}
</CommentPostingBar>
