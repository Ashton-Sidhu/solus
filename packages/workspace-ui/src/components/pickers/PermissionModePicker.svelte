<script lang="ts">
  import { getWorkspaceContext } from '../../contexts'
  import { PERMISSION_MODES, type AgentMetadata, type PermissionMode, type RunConfig } from '@solus/contracts/types'
  import { PERMISSION_MODE_DISPLAY } from '../../lib/permission-modes'
  import * as DropdownMenu from '../ui/dropdown-menu'
  import { workPolicy } from '../../contexts/policy/work-policy.svelte'
  import { runHost } from '../../contexts/workspace/run-location'
  import { pickClosesModelPicker } from './lib/picker-selection'

  const session = getWorkspaceContext()

  interface Props {
    /** The tab whose session this edits. Left unset by a composer that has no
     *  session yet, which supplies `run`/`onRun` instead. */
    tabId?: string;
    /** Detached: the picker writes this run in place and never touches a
     *  session's. A session draft's composer supplies it. */
    run?: RunConfig;
    onRun?: (next: RunConfig) => void;
    permissionMode: PermissionMode;
    capabilities?: AgentMetadata['capabilities'];
    /** The flyout, bound so the shortcut can open it with the model picker. */
    open?: boolean;
  }
  let { tabId, run, onRun, permissionMode, capabilities, open = $bindable(false) }: Props = $props();

  const display = $derived(PERMISSION_MODE_DISPLAY[permissionMode])
  const supportsPermissions = $derived(capabilities?.permissions !== false)
  const supportsPlan = $derived(capabilities?.planMode !== false)
  // The work's policy: its record organization, else the window's (plans/030 §7).
  const tabSession = $derived(onRun ? undefined : session.sessionFor(tabId ?? session.activeTabId))
  const policy = $derived(workPolicy(runHost((onRun ? run : tabSession?.run) ?? session.defaultRunConfig), tabSession?.organizationId))
  const permissionOptions = $derived(PERMISSION_MODES.filter((mode) => mode !== 'plan' || supportsPlan))

  function selectPermissionMode(mode: PermissionMode) {
    if (onRun && run) onRun({ ...run, permissionMode: mode })
    else session.setPermissionMode(mode, tabId)
  }
</script>

<DropdownMenu.Sub bind:open>
  <DropdownMenu.SubTrigger
    class="ml-auto shrink-0 gap-1.5"
    disabled={!supportsPermissions}
    aria-label="Permission mode: {display.label}"
    data-picker-column="footer"
    data-picker-value="permission-mode"
    onpointermove={(event) => event.preventDefault()}
  >
    <display.icon class="text-(--solus-text-tertiary)" />
    <span class="whitespace-nowrap">{display.label}</span>
  </DropdownMenu.SubTrigger>
  <!-- `text-start` is load-bearing: bits-ui also writes `align` onto this div as
       an HTML attribute, and the browser reads `align="end"` as `text-align: end`. -->
  <DropdownMenu.SubContent class="w-[min(18rem,calc(100vw-2rem))] text-start" side="right" align="end" sideOffset={4}>
    <DropdownMenu.RadioGroup value={permissionMode}>
      <DropdownMenu.GroupHeading>Permission mode</DropdownMenu.GroupHeading>
      {#each permissionOptions as mode (mode)}
        {@const option = PERMISSION_MODE_DISPLAY[mode]}
        {@const isChecked = permissionMode === mode}
        {@const denial = policy.modeDenial(mode)?.message ?? null}
        <DropdownMenu.RadioItem value={mode} disabled={denial !== null} title={denial ?? undefined} closeOnSelect={pickClosesModelPicker('permission-mode')} class="h-auto gap-3 py-1.5 pl-1.5" onSelect={() => selectPermissionMode(mode)}>
          <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-tertiary)">
            <option.icon class="size-3.5" />
          </span>
          <span class="flex min-w-0 flex-col gap-0.5">
            <span class="leading-tight {isChecked ? 'text-(--solus-text-primary)' : ''}">{option.label}</span>
            <span class="text-xs leading-tight text-(--solus-text-tertiary) {denial ? 'text-pretty' : 'truncate'}">{denial ?? option.description}</span>
          </span>
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.SubContent>
</DropdownMenu.Sub>
