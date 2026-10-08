<script lang="ts">
  import { GitBranch as GitBranchIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { canDriveSession } from "../../contexts/sharing/session-drive";
  import AttentionCard from "./AttentionCard.svelte";
  import TranscriptCardAction from "./TranscriptCardAction.svelte";
  import { worktreeOfferView, type WorktreeOffer } from "./lib/worktree-offer";

  /**
   * The agent works in a worktree this session is not bound to
   * (docs/worktree-names.md, "Agent worktrees"). The host records the offer and
   * its answer, so the state here is the host's, after a reload too.
   */
  interface Props {
    offer: WorktreeOffer;
    tabId: string;
  }
  let { offer, tabId }: Props = $props();
  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  const view = $derived(worktreeOfferView(offer));
  // The answer is an editor's; a member who may only read sees the offer.
  const canDrive = $derived(canDriveSession(sess?.run.serverId, sess?.id));
  let isDeciding = $state(false);

  async function decide(decision: "switch" | "keep") {
    if (isDeciding) return;
    isDeciding = true;
    try {
      await session.opening.decideWorktreeOffer(tabId, offer.id, decision);
    } finally {
      isDeciding = false;
    }
  }
</script>

<AttentionCard
  title={view.title}
  type={view.type}
  target={view.target}
  resolved={!view.canDecide}
  testId="worktree-offer-card"
  children={view.detail ? detail : undefined}
>
  {#snippet icon()}<GitBranchIcon />{/snippet}
  {#snippet actions()}
    {#if view.canDecide}
      {#if !canDrive}
        <span class="text-transcript-meta text-(--muted-foreground)">Waiting for an editor</span>
      {:else}
        <TranscriptCardAction
          kind="ghost"
          disabled={isDeciding}
          data-testid="worktree-offer-keep"
          onclick={() => void decide("keep")}>Keep current</TranscriptCardAction
        >
        <TranscriptCardAction
          kind="filled"
          disabled={isDeciding}
          data-testid="worktree-offer-switch"
          onclick={() => void decide("switch")}>Switch to it</TranscriptCardAction
        >
      {/if}
    {/if}
  {/snippet}
</AttentionCard>

{#snippet detail()}
  <p class="m-0 text-destructive">{view.detail}</p>
{/snippet}
