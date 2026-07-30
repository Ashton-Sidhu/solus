<script lang="ts">
  import { fly } from 'svelte/transition'
  import { ArrowRightIcon } from 'phosphor-svelte'
  import { getWorkspaceContext } from '../../contexts'
  import type { PermissionRequest, PermissionOption } from '../../../shared/types'
  import { fileChangePreviews } from './lib/fileChangePreview'
  import { permissionFooterOrder, permissionKicker, permissionArgv } from './lib/interrupt'
  import TranscriptChip from './TranscriptChip.svelte'

  interface Props {
    tabId: string
    permission: PermissionRequest
    queueLength?: number
  }

  let { tabId, permission, queueLength = 1 }: Props = $props()

  const session = getWorkspaceContext()
  let responded = $state(false)

  $effect(() => {
    void permission.questionId
    responded = false
  })

  const SENSITIVE_RE = /token|password|secret|key|auth|credential|api.?key/i

  function formatInput(input?: Record<string, unknown>): string | null {
    if (!input) return null
    const entries = Object.entries(input)
    if (entries.length === 0) return null
    const parts: string[] = []
    for (const [key, value] of entries) {
      if (SENSITIVE_RE.test(key)) { parts.push(`${key}: ***`); continue }
      const val = typeof value === 'string' ? value : JSON.stringify(value)
      parts.push(`${key}: ${val.length > 120 ? val.substring(0, 117) + '...' : val}`)
    }
    return parts.join('\n')
  }

  const isEdit = $derived(permission.toolTitle === 'Edit')
  const isWrite = $derived(permission.toolTitle === 'Write')
  const input = $derived(permission.toolInput)
  const editChanges = $derived(fileChangePreviews(input))
  const hasEditStringDetails = $derived(
    typeof input?.old_string === 'string' || typeof input?.new_string === 'string'
  )
  const hasEditDetails = $derived(editChanges.length > 0 || hasEditStringDetails)
  const inputPreview = $derived((isWrite || (isEdit && hasEditDetails)) ? null : formatInput(input))

  // The full argv is the hero and is never truncated — approving a command you
  // can't fully read is the failure mode this card exists to prevent.
  const argv = $derived(permissionArgv(permission))
  const kicker = $derived(permissionKicker(permission))
  // Escape hatch left, affirmative right. Never the reverse, on any interrupt.
  const footer = $derived(permissionFooterOrder(permission.options))

  function handleOption(optionId: string) {
    if (responded) return
    responded = true
    session.respondPermission(tabId, permission.questionId, optionId)
  }

  function classFor(option: PermissionOption): string {
    if (option === footer.affirmative) {
      return kicker.tone === 'destructive' ? 'interrupt-btn interrupt-btn--destructive' : 'interrupt-btn interrupt-btn--primary'
    }
    if (option === footer.escape) return 'interrupt-btn'
    return 'interrupt-btn interrupt-btn--soft'
  }
</script>

{#snippet loadingDiff()}
  <div class="grid min-h-16 place-items-center text-[0.65625rem] text-(--muted-foreground)" role="status">
    Loading preview…
  </div>
{/snippet}

<div transition:fly={{ y: 8, duration: 200 }} class="mx-auto my-2 w-[88%]" data-testid="permission-card">
  <div class="interrupt-card overflow-hidden rounded-xl" class:is-destructive={kicker.tone === 'destructive'}>
    <!-- No spine and no header wash — the status chip is the only hue. -->
    <div class="interrupt-header flex items-start gap-3 px-[1.0625rem] pt-[0.9375rem] pb-[0.8125rem]">
      <div class="min-w-0 flex-1">
        <div class="interrupt-kicker">{kicker.label}</div>
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate text-[0.875rem] leading-tight font-semibold tracking-[-0.012em]">
            {kicker.title}
          </span>
          <TranscriptChip state={kicker.tone === 'destructive' ? 'destructive' : 'warning'}>
            {kicker.chip}
          </TranscriptChip>
        </div>
        <div class="mt-0.5 flex items-center gap-2 text-[0.71875rem] text-(--muted-foreground)">
          <span class="font-mono">{permission.toolTitle}</span>
          {#if queueLength > 1}
            <span class="opacity-40">·</span>
            <span>1 of {queueLength} waiting</span>
          {/if}
        </div>
      </div>
    </div>

    <div class="px-4 pt-[0.8125rem]">
      {#if argv}
        <div class="interrupt-argv overflow-hidden rounded-lg">
          <div class="interrupt-argv-head flex items-center px-3 py-1.5">
            <span class="interrupt-argv-lang font-mono">{argv.label}</span>
          </div>
          <div class="interrupt-argv-body font-mono px-3 py-2.5">{argv.text}</div>
        </div>
      {/if}

      {#if permission.toolDescription}
        <div class="mt-[0.6875rem] flex items-start gap-2 text-[0.78125rem] leading-[1.55] text-(--muted-foreground)">
          <ArrowRightIcon size={13} class="mt-0.5 shrink-0 opacity-50" />
          <span>{permission.toolDescription}</span>
        </div>
      {/if}

      {#if isEdit && editChanges.length > 0}
        <div class="mt-2.5 space-y-1.5">
          {#each editChanges as change (change.path)}
            <div class="interrupt-diff overflow-hidden rounded-lg">
              <div class="interrupt-argv-head flex items-center gap-1.5 px-3 py-1.5">
                <span class="min-w-0 flex-1 truncate font-mono text-[0.65625rem] text-(--muted-foreground)">{change.path}</span>
                <span class="shrink-0 text-[0.65625rem] text-(--muted-foreground) opacity-70">{change.kind}</span>
              </div>
              <div class="max-h-[11.25rem] overflow-auto">
                {#await import('../diff/Diff.svelte')}
                  {@render loadingDiff()}
                {:then diffModule}
                  {@const Diff = diffModule.default}
                  <Diff patch={change.diff} />
                {/await}
              </div>
            </div>
          {/each}
        </div>
      {:else if isEdit && input && hasEditStringDetails}
        {@const oldStr = typeof input.old_string === 'string' ? input.old_string : ''}
        {@const newStr = typeof input.new_string === 'string' ? input.new_string : ''}
        {@const filePath = typeof input.file_path === 'string' ? input.file_path : 'file'}
        <div class="interrupt-diff mt-2.5 overflow-hidden rounded-lg">
          <div class="interrupt-argv-head truncate px-3 py-1.5 font-mono text-[0.65625rem] text-(--muted-foreground)">
            {filePath}
          </div>
          <div class="max-h-[11.25rem] overflow-auto">
            {#await import('../diff/Diff.svelte')}
              {@render loadingDiff()}
            {:then diffModule}
              {@const Diff = diffModule.default}
              <Diff oldFile={{ name: filePath, contents: oldStr }} newFile={{ name: filePath, contents: newStr }} />
            {/await}
          </div>
        </div>
      {/if}

      {#if isWrite && input}
        {@const filePath = typeof input.file_path === 'string' ? input.file_path : 'file'}
        <div class="interrupt-diff mt-2.5 overflow-hidden rounded-lg">
          <div class="interrupt-argv-head truncate px-3 py-1.5 font-mono text-[0.65625rem] text-(--muted-foreground)">
            {filePath}
          </div>
          {#if typeof input.content === 'string'}
            <div class="max-h-[11.25rem] overflow-auto">
              {#await import('../diff/Diff.svelte')}
                {@render loadingDiff()}
              {:then diffModule}
                {@const Diff = diffModule.default}
                <Diff newFile={{ name: filePath, contents: input.content }} />
              {/await}
            </div>
          {/if}
        </div>
      {/if}

      {#if inputPreview}
        <pre class="interrupt-argv-body mt-2.5 max-h-20 overflow-x-auto rounded-lg px-3 py-2 font-mono whitespace-pre-wrap break-all">{inputPreview}</pre>
      {/if}
    </div>

    <div class="interrupt-footer mt-3 flex items-center gap-2 px-3 pt-[0.6875rem] pb-3">
      {#if footer.escape}
        <button type="button" class={classFor(footer.escape)} disabled={responded} data-testid="permission-option" data-kind="deny" onclick={() => handleOption(footer.escape!.optionId)}>
          {footer.escape.label}
          <span class="interrupt-key">esc</span>
        </button>
      {/if}
      <span class="flex-1"></span>
      {#each footer.middle as option (option.optionId)}
        <button type="button" class={classFor(option)} disabled={responded} data-testid="permission-option" data-kind="other" onclick={() => handleOption(option.optionId)}>
          {option.label}
        </button>
      {/each}
      {#if footer.affirmative}
        <button type="button" class={classFor(footer.affirmative)} disabled={responded} data-testid="permission-option" data-kind="allow" onclick={() => handleOption(footer.affirmative!.optionId)}>
          {footer.affirmative.label}
          <span class="interrupt-key">⏎</span>
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .interrupt-card {
    background: var(--card);
    box-shadow: var(--solus-tx-card-shadow);
  }
  /* Destructive tint is reserved for irreversible effects outside the worktree. */
  .interrupt-card.is-destructive {
    box-shadow: 0 0 0 0.03125rem
      color-mix(in oklch, var(--destructive) 26%, transparent);
  }

  .interrupt-header {
    border-bottom: 0.0625rem solid var(--solus-tx-rule);
  }
  .interrupt-card.is-destructive .interrupt-header {
    border-bottom-color: color-mix(in oklch, var(--destructive) 14%, transparent);
  }

  .interrupt-kicker {
    margin-bottom: 0.3125rem;
    font-size: 0.59375rem;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .interrupt-argv,
  .interrupt-diff {
    box-shadow: 0 0 0 0.03125rem
      color-mix(in oklch, var(--foreground) 10%, transparent);
  }
  .interrupt-argv-head {
    background: color-mix(in oklch, var(--foreground) 3.5%, transparent);
  }
  .interrupt-argv-lang {
    font-size: 0.65625rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted-foreground);
  }
  .interrupt-argv-body {
    background: color-mix(in oklch, var(--foreground) 1.5%, var(--card));
    font-size: 0.78125rem;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .interrupt-footer {
    border-top: 0.0625rem solid var(--solus-tx-rule);
  }

  /* Buttons name the outcome, not the verb. */
  :global(.interrupt-btn) {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
    border: none;
    border-radius: 0.5rem;
    background: transparent;
    padding: 0.4375rem 0.75rem;
    color: var(--muted-foreground);
    font-size: 0.78125rem;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  :global(.interrupt-btn):hover:not(:disabled) {
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
  }
  :global(.interrupt-btn):disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  :global(.interrupt-btn--soft) {
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
  }
  :global(.interrupt-btn--primary) {
    padding: 0.4375rem 0.875rem;
    background: var(--primary);
    color: var(--primary-foreground);
  }
  :global(.interrupt-btn--primary):hover:not(:disabled) {
    background: color-mix(in oklch, var(--primary) 88%, var(--foreground));
  }
  :global(.interrupt-btn--destructive) {
    padding: 0.4375rem 0.875rem;
    background: var(--destructive);
    color: var(--destructive-foreground);
  }
  :global(.interrupt-key) {
    margin-left: 0.125rem;
    font-size: 0.65625rem;
    opacity: 0.6;
  }
</style>
