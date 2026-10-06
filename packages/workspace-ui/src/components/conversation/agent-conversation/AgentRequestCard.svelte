<script lang="ts">
  import type { AgentConversationRef } from "@solus/contracts/types";
  import { planKey } from "@solus/contracts/types";
  import type { ExchangeRequest } from "@solus/contracts/session-exchange";
  import { getWorkspaceContext } from "../../../contexts";
  import PlanMessageItem from "../../plan/PlanMessageItem.svelte";
  import PermissionCard from "../PermissionCard.svelte";
  import QuestionCard from "../QuestionCard.svelte";
  import AgentPlanDecision from "./AgentPlanDecision.svelte";
  import { toasts } from "../../../lib/toasts";

  /**
   * What another session's turn is waiting on a person for, shown in the
   * conversation that sent it the work with the same card the other session
   * shows in its own tab. The answer goes to that session; whichever surface
   * answers first wins, and the other is told it was already answered.
   */
  interface Props {
    ref: AgentConversationRef;
    request: ExchangeRequest;
    tabId: string;
  }
  let { ref, request, tabId }: Props = $props();

  const session = getWorkspaceContext();
  const api = $derived(session.apiFor(tabId));
  const ctx = $derived(session.ctxFor(tabId));
  const sess = $derived(session.sessionFor(tabId));
  // This tab's own request keeps the keys; this one is answered by pointer or Tab.
  const shortcuts = $derived(
    !sess?.questionQueue.length && !sess?.permissionQueue.length,
  );

  // The other session may have answered it, or its run ended: say so, never fail silently.
  function answerRefused(error: unknown): false {
    toasts.error("This request is no longer open", { description: error instanceof Error ? error.message : String(error) });
    return false;
  }
</script>

{#if request.kind === "question"}
  <QuestionCard
    {tabId}
    request={request.question}
    provider={ref.provider}
    {shortcuts}
    respond={(questionId, answers) => api.respondQuestion(ctx, ref.sessionId, questionId, answers).catch(answerRefused)}
  />
{:else if request.kind === "permission"}
  <PermissionCard
    {tabId}
    permission={request.permission}
    cwd={ref.cwd}
    {shortcuts}
    respond={(questionId, optionId) => void api.respondPermission(ctx, ref.sessionId, questionId, optionId).catch(answerRefused)}
  />
{:else}
  <div class="flex flex-col gap-2" data-testid="agent-plan-request">
    <PlanMessageItem
      ref={{
        kind: "plan",
        id: request.plan.planToolUseId ? planKey(ref.sessionId, request.plan.planToolUseId) : undefined,
        title: request.plan.title,
        content: request.plan.content,
        status: "pending",
      }}
    />
    <AgentPlanDecision {tabId} targetSessionId={ref.sessionId} />
  </div>
{/if}
