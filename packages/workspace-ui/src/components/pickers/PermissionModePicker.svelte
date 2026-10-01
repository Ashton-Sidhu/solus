<script lang="ts">
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import { getWorkspaceContext, getAgentContext, getStatusBarContext } from '../../contexts'
  import { PERMISSION_MODES, type PermissionMode, type RunConfig } from '@solus/contracts/types'
  import { PERMISSION_MODE_DISPLAY } from '../../lib/permission-modes'
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { requestInputFocus } from '../../lib/inputFocus'
  import * as DropdownMenu from '../ui/dropdown-menu'

  const session = getWorkspaceContext()
  const agent = getAgentContext()
  const statusBar = getStatusBarContext()

  interface Props {
    /** The tab whose session this edits. Left unset by a composer that has no
     *  session yet, which supplies `run`/`onRun` instead. */
    tabId?: string;
    /** Detached: the picker reads and writes this run in place and never
     *  touches a session's. A session draft's composer supplies it. */
    run?: RunConfig;
    onRun?: (next: RunConfig) => void;
    /** Choosing from the workspace's own composer returns focus to it. */
    isPrimary?: boolean;
  }
  let { tabId, run, onRun, isPrimary = false }: Props = $props();

  let open = $state(false)
  let triggerEl: HTMLButtonElement | null = $state(null)

  const ctx = $derived(onRun ? statusBar.ctxForRun(run) : statusBar.ctxFor(tabId ?? session.activeTabId))
  const permissionMode = $derived(ctx.permissionMode)
  const display = $derived(PERMISSION_MODE_DISPLAY[permissionMode])
  const activeAgent = $derived(ctx.activeAgent)
  const capabilities = $derived(
    (agent.metadata[activeAgent] ?? agent.activeMetadata)?.capabilities,
  )
  const supportsPermissions = $derived(capabilities?.permissions !== false)
  const supportsPlan = $derived(capabilities?.planMode !== false)
  const tooltipLabel = $derived.by(() => {
    if (activeAgent === 'codex' && permissionMode === 'plan') return 'Codex read-only planning mode'
    if (activeAgent === 'claude-code' && permissionMode === 'plan') return 'Claude plan mode'
    return 'Permission mode'
  })
  const permissionOptions = $derived(PERMISSION_MODES.filter((mode) => mode !== 'plan' || supportsPlan))

  function handleToggle() {
    if (!supportsPermissions) return
    open = !open
  }

  function selectPermissionMode(mode: PermissionMode) {
    if (onRun && run) onRun({ ...run, permissionMode: mode })
    else session.setPermissionMode(mode, tabId)
    open = false
    if (isPrimary) requestInputFocus()
  }

  // Same shape as the model chip's shortcut: the picker for the addressed tab
  // opens, and only the copy in the visible layout (both stay mounted).
  function openFromShortcut(targetTabId?: string) {
    if (onRun) return
    if (targetTabId === undefined ? !isPrimary : targetTabId !== tabId) return
    if (!supportsPermissions) return
    if (triggerEl && triggerEl.offsetParent === null) return
    open = true
  }

  $effect(() => {
    const handler = (event: Event) => {
      const detail: { tabId?: string } | undefined =
        event instanceof CustomEvent ? event.detail : undefined
      openFromShortcut(detail?.tabId)
    }
    window.addEventListener('solus:toggle-permission-menu', handler)
    return () => window.removeEventListener('solus:toggle-permission-menu', handler)
  })
</script>

<DropdownMenu.Root bind:open onOpenChange={(next) => { if (!next && isPrimary) requestInputFocus() }}>
  <DropdownMenu.Trigger disabled={!supportsPermissions} bind:ref={triggerEl}>
    {#snippet child({ props })}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <button {...tooltipProps}
        {...props}
        type="button"
        class="flex h-[1.875rem] items-center gap-1.5 rounded-lg border-[0.5px] border-(--solus-container-border) px-2.5 font-secondary text-workspace-chrome text-(--solus-text-secondary) transition-[background-color,scale] hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) {open ? 'bg-(--solus-surface-hover)' : ''}"
        style="cursor:{supportsPermissions ? 'pointer' : 'not-allowed'};opacity:{supportsPermissions ? 1 : 0.5}"
      >
        <span class="inline-flex size-4 shrink-0 items-center justify-center text-(--solus-accent)" aria-hidden="true">
          <display.icon class="block size-full" />
        </span>
        <!-- Composer ladder, rung 3: icon-only below 28rem. The shield glyph
             already names the mode, so the word is the cheapest thing on the row
             to spend. Declared here rather than passed down as a prop, so the
             rung is one CSS fact instead of a width measurement each of the
             three composers would have to repeat. -->
        <span class="font-medium whitespace-nowrap @max-[28rem]/composer:hidden">{display.label}</span>
        <CaretDownIcon size={9} class="text-(--solus-text-tertiary) transition-transform duration-150 {open ? 'rotate-180' : ''}" />
      </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={open ? null : tooltipLabel} />
      </TooltipUI.Root>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    side="bottom"
    align="start"
    sideOffset={6}
    class="w-[min(18rem,calc(100vw-2rem))] text-workspace-chrome [&_.menu-row]:text-workspace-chrome"
  >
    <DropdownMenu.RadioGroup value={permissionMode}>
      {#each permissionOptions as mode (mode)}
        {@const option = PERMISSION_MODE_DISPLAY[mode]}
        {@const isChecked = permissionMode === mode}
        <DropdownMenu.RadioItem value={mode} class="h-auto gap-3 py-1.5 pl-1.5" onSelect={() => selectPermissionMode(mode)}>
          <span class="flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors {isChecked ? 'bg-[color-mix(in_srgb,var(--solus-accent)_16%,transparent)] text-(--solus-accent)' : 'bg-(--solus-surface-hover) text-(--solus-text-secondary)'}">
            <option.icon class="size-3.5" />
          </span>
          <span class="flex min-w-0 flex-col gap-0.5">
            <span class="leading-tight {isChecked ? 'text-(--solus-text-primary)' : ''}">{option.label}</span>
            <span class="truncate text-xs leading-tight text-(--solus-text-tertiary)">{option.description}</span>
          </span>
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
