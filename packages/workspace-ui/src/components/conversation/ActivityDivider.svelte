<script lang="ts">
  import type { Activity } from "@solus/contracts/activity";
  import { GitFork as GitForkIcon, CirclePlus as PlusCircleIcon } from "@lucide/svelte";
  import { getWorkspaceContext, getPlanStore } from "../../contexts";
  import { agentLabel } from "../../lib/agentAvailability";
  import ActivityRow from "../activity/ActivityRow.svelte";
  import TranscriptDivider from "./TranscriptDivider.svelte";
  import WorktreeOfferCard from "./WorktreeOfferCard.svelte";
  import { worktreeDividerName } from "./lib/worktree-divider";
  import { presenceStore } from "../../contexts/presence/presence.store.svelte";

  /**
   * One activity in the transcript (plans/012 §5): what a person did as a
   * divider, and the thread's own news — a fork, a move into a worktree, an
   * agent switch, a plan's fresh session — with the action each has always had.
   * An offer to switch into the agent's worktree is a card with its answer.
   */
  interface Props {
    activity: Activity;
    tabId: string;
    skipMotion: boolean;
    /** The switch still open: its target model follows the reader's picker. */
    targetModel: string | null;
    navigateToSourceSession: (sessionId: string) => Promise<void>;
  }
  let { activity, tabId, skipMotion, targetModel, navigateToSourceSession }: Props = $props();
  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const sess = $derived(session.sessionFor(tabId));
  const self = $derived(sess ? presenceStore.currentUserId(sess.run.serverId) : null);
</script>

{#if activity.kind === "forked"}
  <TranscriptDivider
    glyphClass="text-(--solus-accent)"
    ariaLabel="Navigate to source session"
    onclick={() => navigateToSourceSession(activity.sourceSessionId)}
    testid="fork-session-message"
    {skipMotion}
  >
    {#snippet glyph()}<GitForkIcon size={12} />{/snippet}
    <ActivityRow {activity} {self} short title={`"${activity.sourceTitle || "session"}"`} />
  </TranscriptDivider>
{:else if activity.kind === "moved_to_worktree"}
  {@const movedCheckout = sess ? session.environment.checkouts.get(sess.run.serverId, activity.path) : undefined}
  <TranscriptDivider glyphClass="text-(--solus-accent)" testid="worktree-moved-message" {skipMotion}>
    {#snippet glyph()}<GitForkIcon size={12} />{/snippet}
    <ActivityRow
      {activity}
      {self}
      short
      title={worktreeDividerName(activity, movedCheckout ? movedCheckout.checkout : session.environment.environmentFor(sess?.run).checkout)}
    />
  </TranscriptDivider>
{:else if activity.kind === "worktree_offered"}
  <WorktreeOfferCard offer={activity} {tabId} />
{:else if activity.kind === "agent_switched"}
  <TranscriptDivider timestamp={activity.at} testid="agent-handoff-message" {skipMotion}>
    <ActivityRow {activity} {self} short {targetModel} title={agentLabel(activity.provider)} />
  </TranscriptDivider>
{:else if activity.kind === "plan_decided" && activity.newSessionId}
  <!-- The implementation run keeps none of the planning session's context,
       only the plan. Stating that is what separates a deliberate restart from
       a lost thread. -->
  <TranscriptDivider
    glyphClass="text-(--solus-accent)"
    timestamp={activity.at}
    ariaLabel="Open the plan"
    onclick={() => void session.openPlanModal(activity.planId)}
    testid="plan-new-session-message"
    {skipMotion}
  >
    {#snippet glyph()}<PlusCircleIcon size={12} />{/snippet}
    <ActivityRow {activity} {self} short title={`"${planStore.get(activity.planId)?.title || "the plan"}"`} />
  </TranscriptDivider>
{:else}
  <!-- What a person did — approved, renamed, removed a held prompt — as the
       host recorded it. The reducer and the history read add only the rows
       the reader is meant to see. -->
  <TranscriptDivider timestamp={activity.at} testid="activity" {skipMotion}>
    <ActivityRow {activity} {self} short />
  </TranscriptDivider>
{/if}
