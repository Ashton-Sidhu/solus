<script lang="ts">
  import { getWorkspaceContext } from "../../../contexts";
  import { Button } from "../../ui/button";
  import { Textarea } from "../../ui/textarea";
  import { canDriveSession } from "../../../contexts/sharing/session-drive";

  /**
   * A person's decision on a plan another session wrote, taken from the
   * conversation that sent it the work. A plan still holding that session's turn
   * open is answered in place; one whose turn ended is carried on by a new
   * message. Either way the decision is recorded on the plan.
   */
  interface Props {
    tabId: string;
    targetAgentSessionId: string;
  }
  let { tabId, targetAgentSessionId }: Props = $props();

  const session = getWorkspaceContext();
  const api = $derived(session.apiFor(tabId));
  const sess = $derived(session.sessionFor(tabId));
  // The decision is an editor's; a member who may only read sees the plan alone.
  const canDrive = $derived(canDriveSession(sess?.run.serverId, sess?.id));

  let revising = $state(false);
  let comment = $state("");
  let deciding = $state(false);
  let outcome = $state<"approved" | "revising" | "refused" | null>(null);

  async function decide(decision: "approve" | "request_changes") {
    if (deciding) return;
    deciding = true;
    try {
      const decided = await api.decideSessionPlan(
        session.ctxFor(tabId),
        targetAgentSessionId,
        decision,
        decision === "request_changes" ? comment : undefined,
      );
      outcome = !decided ? "refused" : decision === "approve" ? "approved" : "revising";
    } catch {
      outcome = "refused";
    } finally {
      deciding = false;
    }
  }
</script>

{#if outcome === "approved" || outcome === "revising"}
  <span class="text-muted-foreground" data-testid="agent-plan-decided">
    {outcome === "approved" ? "Plan approved" : "Changes requested"}
  </span>
{:else if !canDrive}
  <span class="text-muted-foreground">Waiting for an editor</span>
{:else}
  <div class="flex flex-col gap-2" data-testid="agent-plan-decision">
    {#if revising}
      <Textarea
        bind:value={comment}
        rows={3}
        placeholder="What should change?"
        aria-label="Changes to ask for"
        onkeydown={(e: KeyboardEvent) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && comment.trim()) {
            e.preventDefault();
            void decide("request_changes");
          }
        }}
      />
    {/if}
    <div class="flex items-center gap-2">
      {#if outcome === "refused"}
        <span class="min-w-0 truncate text-muted-foreground">This plan is no longer waiting on a decision</span>
      {/if}
      <span class="flex-1"></span>
      {#if revising}
        <Button variant="ghost" size="sm" disabled={deciding} onclick={() => { revising = false; comment = ""; }}>Cancel</Button>
        <Button size="sm" disabled={deciding || !comment.trim()} onclick={() => decide("request_changes")}>Send changes</Button>
      {:else}
        <Button variant="outline" size="sm" disabled={deciding} onclick={() => (revising = true)}>Request changes</Button>
        <Button size="sm" disabled={deciding} onclick={() => decide("approve")}>Approve</Button>
      {/if}
    </div>
  </div>
{/if}
