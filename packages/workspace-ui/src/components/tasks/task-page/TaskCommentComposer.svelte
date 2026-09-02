<script lang="ts">
  import { ArrowUp as ArrowUpIcon } from "@lucide/svelte";
  import { CommentPostingBar } from "../../ui/comment-posting-bar";
  import { Switch } from "../../ui/switch";

  interface Props {
    /** `alsoPost` is the user's choice for this one comment; the host still
     *  decides what to do with it when the task has no ticket. */
    onSubmit: (body: string, alsoPost: boolean) => Promise<void>;
    /** The system a comment can also be posted to, when this task has one. */
    provider: string | null;
    /** The project posts every comment upstream. The choice is then not this
     *  comment's to make, so the toggle shows it on and says who set it. */
    autoPost: boolean;
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
    provider,
    autoPost,
    class: className,
    compact = false,
    placeholder = "Leave a comment…",
  }: Props = $props();

  let draft = $state("");
  let posting = $state(false);
  let alsoPost = $state(false);

  async function send(body: string) {
    posting = true;
    try {
      await onSubmit(body, autoPost || alsoPost);
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
     accent square rather than a footer bar of chrome. -->
<CommentPostingBar
  value={draft}
  onValueChange={(value) => (draft = value)}
  onSubmit={send}
  disabled={posting}
  {placeholder}
  submitLabel={posting ? "Posting…" : "Comment"}
  class={className}
  submitContent={compact ? sendIcon : undefined}
>
  <!-- Where this comment goes is decided before it is sent, not after: the
       toggle sits under the composer rather than appearing as a regret. -->
  {#snippet below()}
    {#if provider}
      <div class="flex items-center gap-2 px-1 pt-2">
        <Switch
          size="sm"
          checked={autoPost || alsoPost}
          disabled={autoPost}
          onCheckedChange={(next) => (alsoPost = next)}
          aria-label="Also post this comment to {provider}"
        />
        <span class="text-xs text-muted-foreground">
          {autoPost
            ? `Posting to ${provider} (auto-post is on for this project)`
            : `Also post to ${provider}`}
        </span>
      </div>
    {/if}
  {/snippet}
</CommentPostingBar>
