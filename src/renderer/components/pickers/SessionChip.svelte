<script lang="ts">
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import { CaretDownIcon, CaretRightIcon, CheckIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getAgentContext } from "../../contexts/agent.context.svelte";
  import { getStatusBarContext } from "../../contexts/status-bar.context.svelte";
  import { agentLabel, buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import { REASONING_EFFORT_LABELS, type ReasoningEffort, type AgentId } from "../../../shared/types";
  import { tooltip } from "../../lib/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { getPopoverLayer, useClickOutside } from "../popoverLayer.svelte";
  import { portal } from "../portal";
  import DropdownItem from "../ui/DropdownItem.svelte";

  const session = getWorkspaceContext();
  const agentContext = getAgentContext();
  const statusBar = getStatusBarContext();
  const layer = getPopoverLayer();

  const ctx = $derived(statusBar.ctx);
  const sess = $derived(session.sessionFor(session.activeTabId));
  const isBusy = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const isAgentLocked = $derived(
    !!sess?.agentSessionId && sess.status !== "interrupted",
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

  type SubKey = "model" | "agent";

  let open = $state(false);
  let activeSub = $state<SubKey | null>(null);
  let triggerEl: HTMLButtonElement | null = $state(null);
  let rootEl: HTMLDivElement | null = $state(null);
  let subEl: HTMLDivElement | null = $state(null);
  const rowEls: Record<SubKey, HTMLButtonElement | null> = { model: null, agent: null };

  let rootPos = $state({ left: 0, bottom: 0, width: 236 });
  let subPos = $state({ left: 0, top: 0, width: 208 });
  let closeTimer = 0;

  const SUB_TITLES: Record<SubKey, string> = { model: "Model", agent: "Agent" };

  function updateRootPos() {
    if (!triggerEl) return;
    const margin = 8;
    const rect = triggerEl.getBoundingClientRect();
    const width = Math.min(rootPos.width, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(rect.right - width, margin), window.innerWidth - width - margin);
    rootPos = { left, bottom: window.innerHeight - rect.top + 6, width };
  }

  function menuButtons(el: HTMLElement | null): HTMLButtonElement[] {
    return Array.from(el?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
  }

  function focusMenuButton(el: HTMLElement | null, direction: 1 | -1) {
    const buttons = menuButtons(el);
    if (buttons.length === 0) return;
    const current = document.activeElement;
    const currentIndex = current instanceof HTMLButtonElement ? buttons.indexOf(current) : -1;
    const nextIndex = currentIndex === -1
      ? (direction === 1 ? 0 : buttons.length - 1)
      : (currentIndex + direction + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }

  function focusMenuEdge(el: HTMLElement | null, edge: "first" | "last") {
    const buttons = menuButtons(el);
    buttons[edge === "first" ? 0 : buttons.length - 1]?.focus();
  }

  async function focusRootAfterOpen() {
    await tick();
    requestAnimationFrame(() => focusMenuEdge(rootEl, "first"));
  }

  async function toggle() {
    if (isBusy) return;
    if (!open) {
      activeSub = null;
      updateRootPos();
      open = true;
      await focusRootAfterOpen();
      return;
    }
    open = !open;
  }

  async function openFromShortcut() {
    if (isBusy) return;
    // Both the editor- and pill-mode layouts stay mounted, so two SessionChips
    // receive this shortcut. Only the one in the visible layout should open
    // (a display:none ancestor reports offsetParent === null).
    if (triggerEl && triggerEl.offsetParent === null) return;
    activeSub = null;
    updateRootPos();
    open = true;
    await focusRootAfterOpen();
  }

  function close() {
    open = false;
    activeSub = null;
    window.clearTimeout(closeTimer);
    requestInputFocus();
  }

  useClickOutside(
    () => open,
    () => [triggerEl, rootEl, subEl],
    () => close(),
  );

  function openSub(key: SubKey, rowEl: HTMLButtonElement) {
    if (key === "agent" && isAgentLocked) return;
    window.clearTimeout(closeTimer);
    activeSub = key;
    const margin = 8;
    const gap = 6;
    const r = rowEl.getBoundingClientRect();
    const root = rootEl?.getBoundingClientRect();
    const width = Math.min(subPos.width, window.innerWidth - margin * 2);
    const count = key === "model" ? models.length : agentRows.length;
    const estHeight = 30 + count * 30 + 8;
    let left = (root?.right ?? r.right) + gap;
    if (left + width > window.innerWidth - margin) left = (root?.left ?? r.left) - width - gap;
    let top = r.top - 6;
    if (top + estHeight > window.innerHeight - margin) top = window.innerHeight - margin - estHeight;
    if (top < margin) top = margin;
    subPos = { left, top, width };
  }

  function clearSub() {
    window.clearTimeout(closeTimer);
    activeSub = null;
  }

  function scheduleClearSub() {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => (activeSub = null), 140);
  }

  function cancelClearSub() {
    window.clearTimeout(closeTimer);
  }

  function selectReasoning(effort: ReasoningEffort) {
    session.updateModelConfig({ reasoningEffort: effort });
    close();
  }
  function selectModel(modelId: string) {
    session.updateModelConfig({ modelId });
    close();
  }
  function selectAgent(id: AgentId) {
    session.switchActiveAgent(id);
    close();
  }

  function openSubAndFocus(key: SubKey) {
    const rowEl = rowEls[key];
    if (!rowEl) return;
    openSub(key, rowEl);
    void tick().then(() =>
      requestAnimationFrame(() => focusMenuEdge(subEl, "first")),
    );
  }

  // Single document-level handler (capture) drives all in-menu navigation while
  // open. Listening on `document` rather than the portaled menu element makes
  // this robust to where focus actually sits and to Svelte's event delegation.
  // ↑/↓ move within the active list, → opens a row's flyout, ← / Esc step back.
  function onMenuKeydown(e: KeyboardEvent) {
    const inSub = activeSub != null;
    const menuEl = inSub ? subEl : rootEl;
    const active = document.activeElement;
    const rowKey = (["model", "agent"] as SubKey[]).find(
      (k) => rowEls[k] === active,
    );
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        focusMenuButton(menuEl, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        focusMenuButton(menuEl, -1);
        break;
      case "Home":
        e.preventDefault();
        e.stopPropagation();
        focusMenuEdge(menuEl, "first");
        break;
      case "End":
        e.preventDefault();
        e.stopPropagation();
        focusMenuEdge(menuEl, "last");
        break;
      case "ArrowRight":
        if (inSub || !rowKey) return;
        e.preventDefault();
        e.stopPropagation();
        openSubAndFocus(rowKey);
        break;
      case "Enter":
        // On a settings row, Enter opens its flyout; leaf items fall through to
        // the button's native Enter → click.
        if (!inSub && rowKey) {
          e.preventDefault();
          e.stopPropagation();
          openSubAndFocus(rowKey);
        }
        break;
      case "ArrowLeft": {
        if (!inSub) return;
        e.preventDefault();
        e.stopPropagation();
        const key = activeSub;
        activeSub = null;
        if (key) rowEls[key]?.focus();
        break;
      }
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (activeSub) {
          const key = activeSub;
          activeSub = null;
          rowEls[key]?.focus();
        } else {
          close();
        }
        break;
    }
  }

  $effect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => onMenuKeydown(e);
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  });

  $effect(() => {
    const handler = () => void openFromShortcut();
    window.addEventListener("solus:toggle-session-settings-picker", handler);
    return () =>
      window.removeEventListener("solus:toggle-session-settings-picker", handler);
  });
</script>

<button
  bind:this={triggerEl}
  type="button"
  onclick={() => void toggle()}
  onkeydown={(e) => { if (e.key === "Escape" && open) { e.preventDefault(); close(); } }}
  aria-haspopup="menu"
  aria-expanded={open}
  class="flex items-center gap-1 min-w-0 text-[0.75rem] rounded-full px-1.5 py-0.5 transition-[background-color,color,scale] text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary)"
  style="cursor:{isBusy ? 'not-allowed' : 'pointer'}"
  use:tooltip={open ? null : isBusy ? "Stop the task to change session settings" : "Session settings"}
>
  <span class="truncate max-w-28">{modelLabel}</span>
  <span class="flex-shrink-0 opacity-60">{reasoningLabel}</span>
  <CaretDownIcon size={10} style="opacity:0.6" />
</button>

{#if open && layer.el}
  <!-- Root menu -->
  <div
    bind:this={rootEl}
    use:portal={layer.el}
    transition:fly={{ y: 4, duration: 120 }}
    role="menu"
    aria-label="Session settings"
    tabindex="-1"
    class="sc-panel"
    style="bottom:{rootPos.bottom}px;left:{rootPos.left}px;width:{rootPos.width}px"
  >
    <!-- Hovering the reasoning area dismisses any open flyout. -->
    <div class="py-1" role="none" onmouseenter={clearSub}>
      <div class="px-3 pt-1.5 pb-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary)">
        Reasoning
      </div>
      {#each reasoningLevels as level (level)}
        <DropdownItem
          selected={ctx.reasoningEffort === level}
          onclick={() => selectReasoning(level)}
        >
          {REASONING_EFFORT_LABELS[level] ?? level}
          {#snippet trailing()}
            {#if ctx.reasoningEffort === level}
              <CheckIcon size={12} class="text-(--solus-accent)" />
            {/if}
          {/snippet}
        </DropdownItem>
      {/each}
    </div>

    <div class="mx-2.5 border-t border-(--solus-popover-border)"></div>

    <div class="py-1">
      {@render settingRow("model", "Model", modelLabel)}
      {@render settingRow("agent", "Agent", agentName, isAgentLocked)}
    </div>
  </div>

  <!-- Flyout submenu -->
  {#if activeSub}
    <div
      bind:this={subEl}
      use:portal={layer.el}
      transition:fly={{ x: -4, duration: 110 }}
      onmouseenter={cancelClearSub}
      onmouseleave={scheduleClearSub}
      role="menu"
      aria-label={SUB_TITLES[activeSub]}
      tabindex="-1"
      class="sc-panel"
      style="top:{subPos.top}px;left:{subPos.left}px;width:{subPos.width}px"
    >
      <div class="py-1">
        <div class="px-3 pt-1.5 pb-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary)">
          {SUB_TITLES[activeSub]}
        </div>
        {#if activeSub === "model"}
          {#each models as m (m.id)}
            <DropdownItem selected={currentModelId === m.id} onclick={() => selectModel(m.id)}>
              {m.label}
              {#snippet trailing()}
                {#if currentModelId === m.id}<CheckIcon size={12} class="text-(--solus-accent)" />{/if}
              {/snippet}
            </DropdownItem>
          {/each}
        {:else}
          {#each agentRows as a (a.id)}
            <DropdownItem selected={ctx.activeAgent === a.id} onclick={() => selectAgent(a.id)}>
              <span class="min-w-0 truncate">{a.label}</span>
              {#snippet trailing()}
                {#if ctx.activeAgent === a.id}<CheckIcon size={12} class="text-(--solus-accent)" />{/if}
              {/snippet}
            </DropdownItem>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
{/if}

{#snippet settingRow(key: SubKey, label: string, value: string, disabled = false)}
  <button
    bind:this={rowEls[key]}
    type="button"
    {disabled}
    aria-haspopup="menu"
    aria-expanded={activeSub === key}
    onmouseenter={(e) => openSub(key, e.currentTarget)}
    onmouseleave={scheduleClearSub}
    onclick={(e) => (activeSub === key ? clearSub() : openSub(key, e.currentTarget))}
    use:tooltip={disabled ? "Agent is fixed for this session" : null}
    class="sc-row disabled:cursor-not-allowed disabled:opacity-48 disabled:hover:bg-transparent"
    class:sc-row--active={activeSub === key}
  >
    <span class="text-(--solus-text-secondary)">{label}</span>
    <span class="flex items-center gap-1 min-w-0">
      <span class="truncate max-w-24 text-(--solus-text-tertiary)">{value}</span>
      <CaretRightIcon
        size={11}
        class="text-(--solus-text-tertiary) {disabled ? 'opacity-35' : ''}"
      />
    </span>
  </button>
{/snippet}

<style>
  .sc-panel {
    position: fixed;
    z-index: 10002;
    border-radius: 0.75rem;
    background: var(--solus-popover-bg);
    border: 0.0625rem solid var(--solus-popover-border);
    backdrop-filter: blur(1.25rem);
    -webkit-backdrop-filter: blur(1.25rem);
    box-shadow: var(--solus-popover-shadow);
  }
  /* Keyboard focus on menu items shades like .sc-row instead of outlining. */
  .sc-panel :global(.dd-item:focus-visible) {
    outline: none;
    background: var(--solus-accent-light);
    color: var(--solus-text-primary);
  }
  .sc-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.6875rem;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  .sc-row:hover,
  .sc-row--active,
  .sc-row:focus-visible {
    background: var(--solus-accent-light);
    outline: none;
  }
</style>
