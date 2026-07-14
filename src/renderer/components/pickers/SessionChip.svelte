<script lang="ts">
  import { CaretDownIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getAgentContext } from "../../contexts/agent.context.svelte";
  import { getStatusBarContext } from "../../contexts/status-bar.context.svelte";
  import { agentLabel, buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import { REASONING_EFFORT_LABELS, type ReasoningEffort, type AgentId } from "../../../shared/types";
  import { tooltip } from "../../lib/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as DropdownMenu from "../ui/dropdown-menu";

  const session = getWorkspaceContext();
  const agentContext = getAgentContext();
  const statusBar = getStatusBarContext();

  interface Props {
    tabId?: string;
  }
  let { tabId }: Props = $props();

  const ctx = $derived(statusBar.ctxFor(tabId ?? session.activeTabId));
  const sess = $derived(session.sessionFor(tabId ?? session.activeTabId));
  const isBusy = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  // Agent switching flips app-global state (active agent, default model
  // config), so a split-scoped chip never offers it.
  const isAgentLocked = $derived(
    tabId !== undefined ||
      (!!sess?.agentSessionId && sess.status !== "interrupted"),
  );

  // Model
  const modelMeta = $derived(
    agentContext.metadata[ctx.activeAgent] ?? agentContext.activeMetadata,
  );
  const models = $derived(modelMeta?.models ?? []);
  const defaultModel = $derived(modelMeta?.defaultModel ?? models[0]?.id ?? null);
  const currentModelId = $derived(ctx.model || defaultModel);
  const modelLabel = $derived(
    models.find((m) => m.id === currentModelId)?.label ?? currentModelId ?? "",
  );

  // Reasoning — the primary knob, surfaced inline in the chip + menu root.
  const reasoningLevels = $derived(ctx.reasoningLevels);
  const reasoningLabel = $derived(REASONING_EFFORT_LABELS[ctx.reasoningEffort] ?? "High");

  // Agent
  const agentRows = $derived(
    buildAgentAvailabilityRows(agentContext.agents, agentContext.metadata).filter(
      (a) => a.enabled,
    ),
  );
  const agentName = $derived(agentLabel(ctx.activeAgent, agentContext.metadata));

  let open = $state(false);
  let triggerEl: HTMLButtonElement | null = $state(null);

  function openFromShortcut() {
    // The shortcut targets the main bar's chip; a split-scoped chip in the
    // same visible layout must not also open.
    if (tabId !== undefined) return;
    if (isBusy) return;
    // Both the editor- and pill-mode layouts stay mounted, so two SessionChips
    // receive this shortcut. Only the one in the visible layout should open
    // (a display:none ancestor reports offsetParent === null).
    if (triggerEl && triggerEl.offsetParent === null) return;
    open = true;
  }

  function selectReasoning(effort: ReasoningEffort) {
    session.updateModelConfig({ reasoningEffort: effort }, tabId);
  }
  function selectModel(modelId: string) {
    session.updateModelConfig({ modelId }, tabId);
  }
  function selectAgent(id: AgentId) {
    session.switchActiveAgent(id);
  }

  $effect(() => {
    const handler = () => openFromShortcut();
    window.addEventListener("solus:toggle-session-settings-picker", handler);
    return () =>
      window.removeEventListener("solus:toggle-session-settings-picker", handler);
  });
</script>

<DropdownMenu.Root bind:open onOpenChange={(next) => { if (!next && tabId === undefined) requestInputFocus() }}>
  <DropdownMenu.Trigger disabled={isBusy} bind:ref={triggerEl}>
    {#snippet child({ props })}
      <button {...props} type="button" class="flex items-center gap-1 min-w-0 text-[0.75rem] rounded-full px-1.5 py-0.5 transition-[background-color,color,scale] text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary)" style="cursor:{isBusy ? 'not-allowed' : 'pointer'}" use:tooltip={open ? null : isBusy ? "Stop the task to change session settings" : "Session settings"}>
        <span class="truncate max-w-28">{modelLabel}</span>
        <span class="flex-shrink-0 opacity-60">{reasoningLabel}</span>
        <CaretDownIcon size={10} style="opacity:0.6" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="top" align="end" sideOffset={6} class="w-[236px] overflow-visible">
    <DropdownMenu.Group>
      <DropdownMenu.GroupHeading>Reasoning</DropdownMenu.GroupHeading>
      <DropdownMenu.RadioGroup value={ctx.reasoningEffort}>
        {#each reasoningLevels as level (level)}
          <DropdownMenu.RadioItem value={level} onSelect={() => selectReasoning(level)}>{REASONING_EFFORT_LABELS[level] ?? level}</DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Group>
    <DropdownMenu.Separator />
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger><span class="flex-1">Model</span><span class="truncate text-(--solus-text-tertiary)">{modelLabel}</span></DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent class="w-[208px]">
        <DropdownMenu.RadioGroup value={currentModelId ?? undefined}>
          <DropdownMenu.GroupHeading>Model</DropdownMenu.GroupHeading>
          {#each models as model (model.id)}
            <DropdownMenu.RadioItem value={model.id} onSelect={() => selectModel(model.id)}>{model.label}</DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger disabled={isAgentLocked} title={isAgentLocked ? "Agent is fixed for this session" : undefined}><span class="flex-1">Agent</span><span class="truncate text-(--solus-text-tertiary)">{agentName}</span></DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent class="w-[208px]">
        <DropdownMenu.RadioGroup value={ctx.activeAgent}>
          <DropdownMenu.GroupHeading>Agent</DropdownMenu.GroupHeading>
          {#each agentRows as agent (agent.id)}
            <DropdownMenu.RadioItem value={agent.id} onSelect={() => selectAgent(agent.id)}>{agent.label}</DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  </DropdownMenu.Content>
</DropdownMenu.Root>
