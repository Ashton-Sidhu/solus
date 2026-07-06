<script lang="ts">
  import { fly } from "svelte/transition";
  import {
    GearIcon,
    BellIcon,
    MoonIcon,
    MicrophoneIcon,
    TextAaIcon,
    CodeIcon,
    TerminalWindowIcon,
    CaretDownIcon,
    CheckIcon,
    ClockCountdownIcon,
    GitBranchIcon,
    RobotIcon,
    LinkIcon,
  } from "phosphor-svelte";
  import {
    APP_FONT_FAMILIES,
    APP_CODE_FONT_FAMILIES,
    getSettingsContext,
  } from "../contexts/settings.context.svelte";
  import { useKeybinding } from "../lib/keybindings/use-keybinding.svelte";
  import { getAgentContext } from "../contexts/agent.context.svelte";
  import { getWorkspaceContext } from "../contexts/workspace.context.svelte";
  import { getWindowContext } from "../contexts/window.context.svelte";
  import { toolsStore } from "../contexts/tools.store.svelte";
  import { agentLabel, buildAgentAvailabilityRows } from "../lib/agentAvailability";
  import { getPopoverLayer, useClickOutside } from "./popoverLayer.svelte";
  import { portal } from "./portal";
  import { tooltip } from "../lib/tooltip";
  import { requestInputFocus } from "../lib/inputFocus";

  const theme = getSettingsContext();
  const agentContext = getAgentContext();
  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const tools = toolsStore;
  const layer = getPopoverLayer();
  const rateLimitStrats = [
    ["ask", "Ask"],
    ["queue", "Queue"],
    ["stop", "Stop"],
    ["continue", "Continue"],
  ];
  const activeAgentLabel = $derived(agentLabel(theme.activeAgent, agentContext.metadata));
  const allAgentRows = $derived(buildAgentAvailabilityRows(agentContext.agents, agentContext.metadata));
  const agentRows = $derived(allAgentRows.filter((agent) => agent.enabled));

  let open = $state(false);
  let agentOpen = $state(false);
  let editorOpen = $state(false);
  let terminalOpen = $state(false);
  let rateLimitOpen = $state(false);

  let triggerEl: HTMLButtonElement | null = $state(null);
  let popoverEl: HTMLDivElement | null = $state(null);
  let pos = $state<{ left: number; bottom: number }>({ left: 0, bottom: 0 });
  let rafId = 0;

  function updatePos() {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    pos = {
      left: Math.min(rect.left, window.innerWidth - 240 - 8),
      bottom: window.innerHeight - rect.top + 8,
    };
  }

  useClickOutside(
    () => open,
    () => [triggerEl, popoverEl],
    () => {
      open = false;
      agentOpen = false;
      editorOpen = false;
      terminalOpen = false;
      rateLimitOpen = false;
    },
  );

  const isPillMode = $derived(windowCtx.viewMode === "pill" && !windowCtx.isWeb);

  useKeybinding("global.settings", () => {
    if (isPillMode) {
      if (!open) updatePos();
      open = !open;
    } else {
      if (session.settingsOpen) {
        session.closeSettings();
      } else {
        session.showSettings();
      }
    }
  });

  $effect(() => {
    const active = allAgentRows.find((agent) => agent.id === theme.activeAgent);
    if (!active || active.enabled) return;
    const fallback = allAgentRows.find((agent) => agent.enabled);
    if (fallback) session.switchActiveAgent(fallback.id);
  });

  $effect(() => {
    if (!open) return;
    // Retrack every frame so the popover follows the top bar's fly-in animation.
    const tick = () => {
      updatePos();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
    };
  });

  async function handleToggle() {
    if (!isPillMode) {
      if (session.settingsOpen) {
        session.closeSettings();
      } else {
        session.showSettings();
      }
      return;
    }
    if (!open) {
      updatePos();
      await tools.loadDetectedTools();
    } else {
      agentOpen = false;
      editorOpen = false;
      terminalOpen = false;
      rateLimitOpen = false;
    }
    open = !open;
  }

  function selectAgent(agentId: string) {
    session.switchActiveAgent(agentId);
    agentOpen = false;
    requestInputFocus();
  }

  function selectEditor(editorId: string) {
    theme.update({ defaultEditor: editorId });
    editorOpen = false;
    requestInputFocus();
  }

  function selectTerminal(terminalId: string) {
    theme.update({ defaultTerminal: terminalId });
    terminalOpen = false;
    requestInputFocus();
  }

  function selectRateLimitBehavior(
    value: "ask" | "continue" | "stop" | "queue",
  ) {
    theme.update({ rateLimitBehavior: value });
    rateLimitOpen = false;
    requestInputFocus();
  }
</script>

<button
  bind:this={triggerEl}
  onclick={handleToggle}
  class="shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-[background-color,color,scale] text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.92] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary)"
  use:tooltip={open ? null : "Settings"}
>
  <GearIcon size={15} />
</button>

{#if open && layer.el}
  <div
    bind:this={popoverEl}
    use:portal={layer.el}
    transition:fly={{ y: 4, duration: 120 }}
    class="rounded-xl bg-(--solus-popover-bg) border border-(--solus-popover-border)"
    style="
        position:fixed;
        bottom:{pos.bottom}px;
        left:{pos.left}px;
        width:min(15rem, calc(100vw - 1rem));
        backdrop-filter:blur(1.25rem);
        -webkit-backdrop-filter:blur(1.25rem);
        box-shadow:var(--solus-popover-shadow);
      "
  >
    <div class="p-3 flex flex-col gap-2.5">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <BellIcon size={14} class="text-(--solus-text-tertiary)" />
          <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
            Notification sound
          </div>
        </div>
        {@render rowToggle(
          theme.soundEnabled,
          (next) => theme.update({ soundEnabled: next }),
          "Toggle notification sound",
        )}
      </div>

      <div class="h-px bg-(--solus-popover-border)"></div>

      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <MoonIcon size={14} class="text-(--solus-text-tertiary)" />
          <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
            Dark theme
          </div>
        </div>
        {@render rowToggle(
          theme.themeMode === "dark",
          (next) => theme.update({ themeMode: next ? "dark" : "light" }),
          "Toggle dark theme",
        )}
      </div>

      <div class="h-px bg-(--solus-popover-border)"></div>

      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <RobotIcon size={14} class="text-(--solus-text-tertiary)" />
          <div>
            <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
              Default agent
            </div>
          </div>
        </div>
        <div class="relative">
          <button
            type="button"
            onclick={() => {
              agentOpen = !agentOpen;
              editorOpen = false;
              terminalOpen = false;
              rateLimitOpen = false;
            }}
            class="flex items-center gap-1 text-[0.6875rem] rounded-full px-2 py-0.5 transition-colors text-(--solus-text-secondary) bg-(--solus-surface-secondary) border border-(--solus-container-border)"
          >
            <span class="max-w-20 truncate">{activeAgentLabel}</span>
            <CaretDownIcon size={9} style="opacity:0.6" />
          </button>
          {#if agentOpen}
            <div
              class="rounded-xl bg-(--solus-popover-bg) border border-(--solus-popover-border)"
              style="
                position:absolute;
                top:calc(100% + 0.25rem);
                right:0;
                min-width:8.75rem;
                z-index:100;
                backdrop-filter:blur(1.25rem);
                -webkit-backdrop-filter:blur(1.25rem);
                box-shadow:var(--solus-popover-shadow);
              "
            >
              <div class="py-1">
                {#each agentRows as agent (agent.id)}
                  <button
                    type="button"
                    aria-label={`Use ${agent.label} as the default agent`}
                    onclick={() => selectAgent(agent.id)}
                    class="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[0.6875rem] transition-[background-color,color,opacity] focus-visible:outline-none focus-visible:bg-(--solus-accent-light)"
                    style="
                      color:{agent.id === theme.activeAgent
                        ? 'var(--solus-text-primary)'
                        : 'var(--solus-text-secondary)'};
                      font-weight:{agent.id === theme.activeAgent ? 600 : 400};
                      cursor:pointer;
                      opacity:1;
                    "
                    onmouseenter={(e) => {
                      (e.currentTarget as HTMLElement).style.background =
                        "var(--solus-accent-light)";
                    }}
                    onmouseleave={(e) => {
                      (e.currentTarget as HTMLElement).style.background =
                        "transparent";
                    }}
                  >
                    <span class="min-w-0 truncate">{agent.label}</span>
                    {#if agent.id === theme.activeAgent}<CheckIcon
                        size={12}
                        class="shrink-0 text-(--solus-accent)"
                      />{/if}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>

      <div class="h-px bg-(--solus-popover-border)"></div>

      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <TextAaIcon size={14} class="text-(--solus-text-tertiary)" />
          <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
            App font
          </div>
        </div>
        <div class="relative">
          <select
            name="app-font"
            aria-label="App font"
            value={theme.fontFamily}
            onchange={(e) => {
              theme.update({ fontFamily: e.currentTarget.value as typeof theme.fontFamily });
              requestInputFocus();
            }}
            class="appearance-none min-w-20 rounded-full border border-(--solus-container-border) bg-(--solus-surface-secondary) py-0.5 pl-2 pr-6 text-[0.6875rem] text-(--solus-text-secondary) outline-none focus:border-(--solus-accent)/50"
          >
            {#each APP_FONT_FAMILIES as font (font.id)}
              <option value={font.id}>{font.label}</option>
            {/each}
          </select>
          <CaretDownIcon
            size={9}
            class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-(--solus-text-tertiary)"
          />
        </div>
      </div>

      <div class="h-px bg-(--solus-popover-border)"></div>

      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <TextAaIcon size={14} class="text-(--solus-text-tertiary)" />
          <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
            Font size
          </div>
        </div>
        <div
          class="flex items-center rounded-full border border-(--solus-container-border) bg-(--solus-surface-secondary) overflow-hidden"
        >
          <button
            onclick={() =>
              theme.update({ fontSize: Math.max(8, theme.fontSize - 1) })}
            class="px-2 py-0.5 text-[0.75rem] text-(--solus-text-secondary) hover:text-(--solus-text-primary) transition-colors"
            >&minus;</button
          >
          <input
            type="number"
            min="8"
            step="1"
            value={theme.fontSize}
            onchange={(e) => {
              const v = Math.max(8, Number(e.currentTarget.value));
              theme.update({ fontSize: v });
              e.currentTarget.value = String(v);
            }}
            class="w-10 text-[0.6875rem] text-center bg-transparent text-(--solus-text-primary) outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span class="text-[0.625rem] text-(--solus-text-tertiary) -ml-1 mr-1"
            >px</span
          >
          <button
            onclick={() => theme.update({ fontSize: theme.fontSize + 1 })}
            class="px-2 py-0.5 text-[0.75rem] text-(--solus-text-secondary) hover:text-(--solus-text-primary) transition-colors"
            >+</button
          >
        </div>
      </div>

      <div class="h-px bg-(--solus-popover-border)"></div>

      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <CodeIcon size={14} class="text-(--solus-text-tertiary)" />
          <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
            Code font
          </div>
        </div>
        <div class="relative">
          <select
            name="code-font"
            aria-label="Code font"
            value={theme.codeFontFamily}
            onchange={(e) => {
              theme.update({ codeFontFamily: e.currentTarget.value as typeof theme.codeFontFamily });
              requestInputFocus();
            }}
            class="appearance-none min-w-20 rounded-full border border-(--solus-container-border) bg-(--solus-surface-secondary) py-0.5 pl-2 pr-6 text-[0.6875rem] text-(--solus-text-secondary) outline-none focus:border-(--solus-accent)/50"
          >
            {#each APP_CODE_FONT_FAMILIES as font (font.id)}
              <option value={font.id}>{font.label}</option>
            {/each}
          </select>
          <CaretDownIcon
            size={9}
            class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-(--solus-text-tertiary)"
          />
        </div>
      </div>

      <div class="h-px bg-(--solus-popover-border)"></div>

      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <CodeIcon size={14} class="text-(--solus-text-tertiary)" />
          <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
            Code font size
          </div>
        </div>
        <div
          class="flex items-center rounded-full border border-(--solus-container-border) bg-(--solus-surface-secondary) overflow-hidden"
        >
          <button
            onclick={() =>
              theme.update({ codeFontSize: Math.max(8, theme.codeFontSize - 1) })}
            class="px-2 py-0.5 text-[0.75rem] text-(--solus-text-secondary) hover:text-(--solus-text-primary) transition-colors"
            >&minus;</button
          >
          <input
            type="number"
            min="8"
            step="1"
            value={theme.codeFontSize}
            onchange={(e) => {
              const v = Math.max(8, Number(e.currentTarget.value));
              theme.update({ codeFontSize: v });
              e.currentTarget.value = String(v);
            }}
            class="w-10 text-[0.6875rem] text-center bg-transparent text-(--solus-text-primary) outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span class="text-[0.625rem] text-(--solus-text-tertiary) -ml-1 mr-1"
            >px</span
          >
          <button
            onclick={() => theme.update({ codeFontSize: theme.codeFontSize + 1 })}
            class="px-2 py-0.5 text-[0.75rem] text-(--solus-text-secondary) hover:text-(--solus-text-primary) transition-colors"
            >+</button
          >
        </div>
      </div>

      <div class="h-px bg-(--solus-popover-border)"></div>

      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <MicrophoneIcon size={14} class="text-(--solus-text-tertiary)" />
          <div>
            <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
              Voice mode
            </div>
            <div class="text-[0.625rem] text-(--solus-text-tertiary)">
              ⌥⇧V to toggle
            </div>
          </div>
        </div>
        {@render rowToggle(
          theme.voiceModeEnabled,
          (next) => theme.update({ voiceModeEnabled: next }),
          "Toggle voice mode",
        )}
      </div>

      {#if tools.detectedEditors.length > 0}
        <div class="h-px bg-(--solus-popover-border)"></div>

        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 min-w-0">
            <CodeIcon size={14} class="text-(--solus-text-tertiary)" />
            <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
              Editor
            </div>
          </div>
          <div class="relative">
            <button
              onclick={() => {
                editorOpen = !editorOpen;
                agentOpen = false;
                terminalOpen = false;
                rateLimitOpen = false;
              }}
              class="flex items-center gap-1 text-[0.6875rem] rounded-full px-2 py-0.5 transition-colors text-(--solus-text-secondary) bg-(--solus-surface-secondary) border border-(--solus-container-border)"
            >
              {tools.detectedEditors.find((e) => e.id === theme.defaultEditor)
                ?.name ?? "None"}
              <CaretDownIcon size={9} style="opacity:0.6" />
            </button>
            {#if editorOpen}
              {@const selected = theme.defaultEditor ?? ""}
              <div
                class="rounded-xl bg-(--solus-popover-bg) border border-(--solus-popover-border)"
                style="
                    position:absolute;
                    top:calc(100% + 0.25rem);
                    right:0;
                    min-width:8.125rem;
                    z-index:100;
                    backdrop-filter:blur(1.25rem);
                    -webkit-backdrop-filter:blur(1.25rem);
                    box-shadow:var(--solus-popover-shadow);
                  "
              >
                <div class="py-1">
                  {#each tools.detectedEditors as editor (editor.id)}
                    <button
                      onclick={() => selectEditor(editor.id)}
                      class="w-full flex items-center justify-between px-3 py-1.5 text-[0.6875rem] transition-colors hover:bg-(--solus-accent-light)"
                      style="color:{selected === editor.id
                        ? 'var(--solus-text-primary)'
                        : 'var(--solus-text-secondary)'};font-weight:{selected ===
                      editor.id
                        ? 600
                        : 400}"
                    >
                      {editor.name}
                      {#if selected === editor.id}<CheckIcon
                          size={12}
                          class="text-(--solus-accent)"
                        />{/if}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      {#if tools.detectedTerminals.length > 0}
        <div class="h-px bg-(--solus-popover-border)"></div>

        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 min-w-0">
            <TerminalWindowIcon
              size={14}
              class="text-(--solus-text-tertiary)"
            />
            <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
              Terminal
            </div>
          </div>
          <div class="relative">
            <button
              onclick={() => {
                terminalOpen = !terminalOpen;
                agentOpen = false;
                editorOpen = false;
                rateLimitOpen = false;
              }}
              class="flex items-center gap-1 text-[0.6875rem] rounded-full px-2 py-0.5 transition-colors text-(--solus-text-secondary) bg-(--solus-surface-secondary) border border-(--solus-container-border)"
            >
              {tools.detectedTerminals.find(
                (t) => t.id === (theme.defaultTerminal ?? "default-terminal"),
              )?.name ?? "Default"}
              <CaretDownIcon size={9} style="opacity:0.6" />
            </button>
            {#if terminalOpen}
              {@const selected = theme.defaultTerminal ?? "default-terminal"}
              <div
                class="rounded-xl bg-(--solus-popover-bg) border border-(--solus-popover-border)"
                style="
                    position:absolute;
                    top:calc(100% + 0.25rem);
                    right:0;
                    min-width:8.125rem;
                    z-index:100;
                    backdrop-filter:blur(1.25rem);
                    -webkit-backdrop-filter:blur(1.25rem);
                    box-shadow:var(--solus-popover-shadow);
                  "
              >
                <div class="py-1">
                  {#each tools.detectedTerminals as terminal (terminal.id)}
                    <button
                      onclick={() => selectTerminal(terminal.id)}
                      class="w-full flex items-center justify-between px-3 py-1.5 text-[0.6875rem] transition-colors hover:bg-(--solus-accent-light)"
                      style="color:{selected === terminal.id
                        ? 'var(--solus-text-primary)'
                        : 'var(--solus-text-secondary)'};font-weight:{selected ===
                      terminal.id
                        ? 600
                        : 400}"
                    >
                      {terminal.name}
                      {#if selected === terminal.id}<CheckIcon
                          size={12}
                          class="text-(--solus-accent)"
                        />{/if}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <div class="h-px bg-(--solus-popover-border)"></div>

      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <ClockCountdownIcon size={14} class="text-(--solus-text-tertiary)" />
          <div class="min-w-0">
            <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
              Rate limit
            </div>
            <div class="text-[0.625rem] text-(--solus-text-tertiary)">
              When limit is hit
            </div>
          </div>
        </div>
        <div class="relative">
          <button
            onclick={() => {
              rateLimitOpen = !rateLimitOpen;
              agentOpen = false;
              editorOpen = false;
              terminalOpen = false;
            }}
            class="flex items-center gap-1 text-[0.6875rem] rounded-full px-2 py-0.5 transition-colors text-(--solus-text-secondary) bg-(--solus-surface-secondary) border border-(--solus-container-border)"
          >
            {theme.rateLimitBehavior.at(0)?.toUpperCase() +
              theme.rateLimitBehavior.slice(1)}
            <CaretDownIcon size={9} style="opacity:0.6" />
          </button>
          {#if rateLimitOpen}
            {@const selected = theme.rateLimitBehavior}
            <div
              class="rounded-xl bg-(--solus-popover-bg) border border-(--solus-popover-border)"
              style="
                position:absolute;
                bottom:calc(100% + 0.25rem);
                right:0;
                min-width:6.25rem;
                z-index:100;
                backdrop-filter:blur(1.25rem);
                -webkit-backdrop-filter:blur(1.25rem);
                box-shadow:var(--solus-popover-shadow);
              "
            >
              <div class="py-1">
                {#each rateLimitStrats as [val, label] (val)}
                  <button
                    onclick={() =>
                      selectRateLimitBehavior(
                        val as "ask" | "continue" | "stop" | "queue",
                      )}
                    class="w-full flex items-center justify-between px-3 py-1.5 text-[0.6875rem] transition-colors hover:bg-(--solus-accent-light)"
                    style="color:{selected === val
                      ? 'var(--solus-text-primary)'
                      : 'var(--solus-text-secondary)'};font-weight:{selected ===
                    val
                      ? 600
                      : 400}"
                  >
                    {label}
                    {#if selected === val}<CheckIcon
                        size={12}
                        class="text-(--solus-accent)"
                      />{/if}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
      <div class="h-px bg-(--solus-popover-border)"></div>

      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <GitBranchIcon size={14} class="text-(--solus-text-tertiary)" />
          <div>
            <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
              Git Worktrees for Sessions
            </div>
          </div>
        </div>
        {@render rowToggle(
          theme.worktreeEnabled,
          (next) => {
            theme.update({ worktreeEnabled: next });
            session.syncWorktreeDefault(next);
          },
          "Toggle default worktree mode for new tabs",
        )}
      </div>

      <div class="h-px bg-(--solus-popover-border)"></div>

      <button
        type="button"
        onclick={() => {
          open = false;
          session.showSettings('api-access');
        }}
        class="flex items-center justify-between gap-3 w-full text-left"
      >
        <div class="flex items-center gap-2 min-w-0">
          <LinkIcon size={14} class="text-(--solus-text-tertiary)" />
          <div class="text-[0.75rem] font-medium text-(--solus-text-primary)">
            Remote Access
          </div>
        </div>
        <CaretDownIcon
          size={11}
          class="text-(--solus-text-tertiary)"
          style="transform: rotate(-90deg)"
        />
      </button>
    </div>

    {#if session.staticInfo?.version}
      <div
        class="px-3 py-1.5 text-center text-[0.5625rem] text-(--solus-text-tertiary) border-t border-(--solus-popover-border)"
        style="opacity:0.6"
      >
        Solus v{session.staticInfo.version}
      </div>
    {/if}
  </div>
{/if}

{#snippet rowToggle(checked: boolean, onChange: (next: boolean) => void, label: string)}
  <button
    type="button"
    aria-label={label}
    aria-pressed={checked}
    onclick={() => onChange(!checked)}
    class="relative w-9 h-5 rounded-full transition-colors shrink-0"
    class:bg-(--solus-accent)={checked}
    class:bg-(--solus-surface-secondary)={!checked}
    class:border-(--solus-accent)={checked}
    class:border-(--solus-container-border)={!checked}
    style="border-width:0.0625rem;border-style:solid"
  >
    <span
      class="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full transition-[left]"
      style="left:{checked ? 18 : 2}px;background:#fff"
    ></span>
  </button>
{/snippet}
