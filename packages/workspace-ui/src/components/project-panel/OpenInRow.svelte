<script lang="ts">
  import { ChevronDown, Code, Check } from '@lucide/svelte';
  import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat';
  import { hostPolicy } from '@solus/client-core/host-policy';
  import { getWorkspaceContext, getSessionEnvironmentStore, hosts, toolsStore } from '../../contexts';
  import { runHost } from '../../contexts/workspace/run-location';
  import { requestInputFocus } from '../../lib/inputFocus';
  import { comboHint } from '../../lib/keybindings/manifest';
  import { toasts } from '../../lib/toasts';
  import AppLogo from '../settings/AppLogo.svelte';
  import TerminalAppLogo from '../settings/TerminalAppLogo.svelte';
  import * as DropdownMenu from '../ui/dropdown-menu';
  import MenuRow from './MenuRow.svelte';
  import { openInTarget, type OpenInTarget } from './lib/open-in';
  import { openInStore } from './lib/open-in.store.svelte';

  let { sourceId, active, openTerminal }: { sourceId: string; active: boolean; openTerminal: () => void } = $props();
  const workspace = getWorkspaceContext();
  const environments = getSessionEnvironmentStore();
  const run = $derived(workspace.runFor(sourceId));
  const host = $derived(hosts.get(runHost(run)));
  const environment = $derived(environments.environmentFor(run));
  const canOpen = $derived(hostPolicy.isClientMachine(host?.id) && !!hosts.device?.hasDesktopHandlers);
  const tools = $derived(active && canOpen ? host?.tools : undefined);
  const editors = $derived(tools?.state === 'ready' ? tools.value.editors : []);
  const target = $derived(openInTarget(openInStore.chosen, workspace.settings.defaultEditor, editors));
  const editor = $derived(editors.find((item) => item.id === target));
  const isLoading = $derived(tools?.state === 'loading');
  const cwd = $derived(environment.checkout?.worktreePath || environment.cwd);
  const hasFolder = $derived(!!cwd && cwd !== NEW_CHAT_DIRECTORY);
  const permitted = $derived(host?.me.may(target === 'terminal' || editor?.isTerminal ? 'host.terminal' : 'host.local.window') ?? false);
  let menuOpen = $state(false);
  let anchor = $state<HTMLElement | null>(null);

  async function open(target: OpenInTarget) {
    if (!canOpen || !hasFolder) return;
    if (target === 'terminal') {
      openTerminal();
      return;
    }
    if (!cwd) return;
    const ctx = workspace.ctxForEnvironment(environment.cwd, environment.checkout, sourceId);
    try {
      const opened = await workspace.apiFor(sourceId).openInEditor(ctx, {
        editorId: target,
        filePaths: [cwd],
        cwd,
        fallbackTerminalId: workspace.settings.fallbackTerminal ?? undefined,
      });
      if (!opened) toasts.error(`Could not open ${editors.find((item) => item.id === target)?.name ?? target}`);
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : 'Could not open the editor');
    }
    requestInputFocus();
  }

  function choose(target: OpenInTarget) {
    openInStore.choose(target);
    void open(target);
  }
</script>

<div class="flex items-stretch gap-px">
  <MenuRow
    split
    item={{
      key: 'open-in',
      label: isLoading ? 'Checking applications…' : `Open in ${editor?.name ?? 'Terminal'}`,
      icon: Code,
      phase: isLoading ? 'loading' : 'idle',
      disabled: !canOpen || !permitted || !hasFolder || isLoading,
      hint: target === 'terminal' ? comboHint('orb.open-terminal') : undefined,
      tooltip: !canOpen ? 'Available for local desktop sessions' : undefined,
    }}
    onInspect={() => { if (active && target === 'terminal') void toolsStore.refreshResolvedTerminal(workspace.settings.fallbackTerminal); }}
    onActivate={() => void open(target)}
  >
    {#snippet iconSnippet()}
      {#if editor}
        <AppLogo id={editor.id} kind="editor" size={16} />
      {:else}
        <TerminalAppLogo size={16} />
      {/if}
    {/snippet}
  </MenuRow>
  <button
    type="button"
    class="inline-flex w-[1.625rem] shrink-0 items-center justify-center rounded-[0.4375rem] text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
    aria-label="Choose application"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    disabled={!canOpen || !hasFolder}
    onclick={(event) => {
      anchor = event.currentTarget;
      menuOpen = !menuOpen;
    }}
  >
    <ChevronDown size={11} />
  </button>
</div>
<DropdownMenu.Root bind:open={menuOpen}>
  <DropdownMenu.Content
    customAnchor={anchor?.parentElement ?? anchor}
    side="bottom"
    align="start"
    sideOffset={4}
    alignOffset={0}
    collisionPadding={8}
    onInteractOutside={(event) => {
      if (anchor?.contains(event.target as Node | null)) event.preventDefault();
    }}
    onCloseAutoFocus={(event) => {
      event.preventDefault();
      requestInputFocus();
    }}
  >
    <DropdownMenu.Item role="menuitemradio" aria-checked={target === 'terminal'} disabled={!host?.me.may('host.terminal')} onSelect={() => choose('terminal')}>
      <TerminalAppLogo size={16} />
      <span class="min-w-0 flex-1 truncate">Terminal</span>
      {#if target === 'terminal'}<Check size={16} />{/if}
    </DropdownMenu.Item>
    {#each editors as option (option.id)}
      <DropdownMenu.Item role="menuitemradio" aria-checked={target === option.id} disabled={!host?.me.may(option.isTerminal ? 'host.terminal' : 'host.local.window')} onSelect={() => choose(option.id)}>
        <AppLogo id={option.id} kind="editor" size={16} />
        <span class="min-w-0 flex-1 truncate">{option.name}</span>
        {#if target === option.id}<Check size={16} />{/if}
      </DropdownMenu.Item>
    {/each}
    {#if tools?.state === 'loading'}
      <DropdownMenu.Item disabled>Checking installed editors…</DropdownMenu.Item>
    {:else if tools?.state === 'error'}
      <DropdownMenu.Item disabled>Could not load installed editors</DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
