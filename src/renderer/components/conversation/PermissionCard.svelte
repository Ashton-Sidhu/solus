<script lang="ts">
  import { fly } from 'svelte/transition'
  import { ShieldWarningIcon, TerminalIcon, PencilSimpleIcon, GlobeIcon, WrenchIcon } from 'phosphor-svelte'
  import type { Component } from 'svelte'
  import { getWorkspaceContext } from '../../contexts/workspace.context.svelte'
  import type { PermissionRequest } from '../../../shared/types'
  import Diff from '../diff/Diff.svelte'

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

  const TOOL_ICON_MAP: Record<string, Component> = {
    Bash: TerminalIcon,
    Edit: PencilSimpleIcon,
    Write: PencilSimpleIcon,
    WebSearch: GlobeIcon,
    WebFetch: GlobeIcon,
  }
  const SENSITIVE_RE = /token|password|secret|key|auth|credential|api.?key/i

  type FileChangePreview = {
    path: string
    kind: string
    diff: string
  }

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

  function formatChangeKind(kind: unknown): string {
    if (!kind || typeof kind !== 'object' || !('type' in kind)) return 'update'
    const type = String(kind.type)
    if (type !== 'update') return type
    const movePath = 'move_path' in kind && typeof kind.move_path === 'string' ? kind.move_path : null
    return movePath ? `move to ${movePath}` : 'update'
  }

  function fileChangePreviews(input?: Record<string, unknown>): FileChangePreview[] {
    const changes = input?.changes
    if (!Array.isArray(changes)) return []

    return changes
      .map((change): FileChangePreview | null => {
        if (!change || typeof change !== 'object') return null
        const path = 'path' in change && typeof change.path === 'string' ? change.path : 'file'
        const diff = 'diff' in change && typeof change.diff === 'string' ? change.diff : ''
        if (!diff) return null
        return {
          path,
          kind: formatChangeKind('kind' in change ? change.kind : null),
          diff,
        }
      })
      .filter((change): change is FileChangePreview => change !== null)
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
  const ToolIcon = $derived(TOOL_ICON_MAP[permission.toolTitle] || WrenchIcon)

  function handleOption(optionId: string) {
    if (responded) return
    responded = true
    session.respondPermission(tabId, permission.questionId, optionId)
  }
</script>

<div transition:fly={{ y: 8, duration: 200 }} class="mx-4 mt-2 mb-2" data-testid="permission-card">
  <div
    class="overflow-hidden bg-(--solus-container-bg) border border-(--solus-permission-border)"
    style="border-radius:0.75rem;box-shadow:var(--solus-permission-shadow)"
  >
    <div
      class="flex items-center gap-1.5 px-3 py-1.5 bg-(--solus-permission-header-bg) border-b border-(--solus-permission-header-border)"
    >
      <ShieldWarningIcon size={12} class="text-(--solus-status-permission)" />
      <span class="text-xs sm:text-[0.6875rem] font-semibold text-(--solus-status-permission)">Permission Required</span>
    </div>

    <div class="px-3 py-2.5">
      <div class="flex items-center gap-1.5 mb-1">
        <span class="text-(--solus-text-tertiary)"><ToolIcon size={14} /></span>
        <span class="text-[0.75rem] font-medium text-(--solus-text-primary)">{permission.toolTitle}</span>
      </div>

      {#if permission.toolDescription}
        <p class="text-sm sm:text-xs leading-[1.4] mb-1.5 text-(--solus-text-secondary)">
          {permission.toolDescription}
        </p>
      {/if}

      {#if isEdit && editChanges.length > 0}
        <div class="mb-2 space-y-1.5">
          {#each editChanges as change (change.path)}
            <div class="overflow-hidden rounded-md border border-(--solus-permission-header-border)">
              <div class="flex items-center gap-1.5 border-b border-(--solus-permission-header-border) bg-(--solus-code-bg) px-2 py-1 text-xs sm:text-[0.625rem] text-(--solus-text-secondary)">
                <span class="truncate min-w-0 flex-1">{change.path}</span>
                <span class="shrink-0 text-(--solus-text-tertiary)">{change.kind}</span>
              </div>
              <div class="max-h-[11.25rem] overflow-auto bg-(--solus-container-bg)">
                <Diff patch={change.diff} />
              </div>
            </div>
          {/each}
        </div>
      {:else if isEdit && input && hasEditStringDetails}
        {@const oldStr = typeof input.old_string === 'string' ? input.old_string : ''}
        {@const newStr = typeof input.new_string === 'string' ? input.new_string : ''}
        {@const filePath = typeof input.file_path === 'string' ? input.file_path : 'file'}
        <div class="mb-2 overflow-hidden rounded-md border border-(--solus-permission-header-border)">
          {#if typeof input.file_path === 'string'}
            <div class="truncate border-b border-(--solus-permission-header-border) bg-(--solus-code-bg) px-2 py-1 text-xs sm:text-[0.625rem] text-(--solus-text-secondary)">
              {input.file_path}
            </div>
          {/if}
          <div class="max-h-[11.25rem] overflow-auto bg-(--solus-container-bg)">
            <Diff
              oldFile={{ name: filePath, contents: oldStr }}
              newFile={{ name: filePath, contents: newStr }}
            />
          </div>
        </div>
      {/if}

      {#if isWrite && input}
        <div class="mb-2 overflow-hidden rounded-md border border-(--solus-permission-header-border)">
          {#if typeof input.file_path === 'string'}
            <div class="truncate border-b border-(--solus-permission-header-border) bg-(--solus-code-bg) px-2 py-1 text-xs sm:text-[0.625rem] text-(--solus-text-secondary)">
              {input.file_path}
            </div>
          {/if}
          {#if typeof input.content === 'string'}
            {@const filePath = typeof input.file_path === 'string' ? input.file_path : 'file'}
            <div class="max-h-[11.25rem] overflow-auto bg-(--solus-container-bg)">
              <Diff
                newFile={{ name: filePath, contents: input.content }}
              />
            </div>
          {/if}
        </div>
      {/if}

      {#if inputPreview}
        <pre
          class="text-xs sm:text-[0.625rem] leading-[1.4] px-2 py-1.5 rounded-md overflow-x-auto whitespace-pre-wrap break-all mb-2 bg-(--solus-code-bg) text-(--solus-text-secondary)"
          style="max-height:5rem"
        >{inputPreview}</pre>
      {/if}

      <div class="flex items-center gap-2 flex-wrap">
        {#each permission.options as opt (opt.optionId)}
          {@const isAllow = opt.kind === 'allow' || opt.label.toLowerCase().includes('allow') || opt.label.toLowerCase().includes('yes')}
          {@const isDeny = opt.kind === 'deny' || opt.label.toLowerCase().includes('deny') || opt.label.toLowerCase().includes('no') || opt.label.toLowerCase().includes('reject')}
          {@const bg = isAllow ? 'var(--solus-permission-allow-bg)' : isDeny ? 'var(--solus-permission-deny-bg)' : 'var(--solus-accent-light)'}
          {@const hoverBg = isAllow ? 'var(--solus-permission-allow-hover-bg)' : isDeny ? 'var(--solus-permission-deny-hover-bg)' : 'var(--solus-accent-soft)'}
          {@const textColor = isAllow ? 'var(--solus-status-complete)' : isDeny ? 'var(--solus-status-error)' : 'var(--solus-accent)'}
          {@const borderColor = isAllow ? 'var(--solus-permission-allow-border)' : isDeny ? 'var(--solus-permission-deny-border)' : 'var(--solus-accent-soft)'}
          <button
            onclick={() => handleOption(opt.optionId)}
            disabled={responded}
            data-testid="permission-option"
            data-kind={isAllow ? 'allow' : isDeny ? 'deny' : 'other'}
            class="text-xs sm:text-[0.6875rem] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style="background:{bg};color:{textColor};border:0.0625rem solid {borderColor}"
            onmouseenter={(e) => { if (!responded) (e.currentTarget as HTMLElement).style.background = hoverBg }}
            onmouseleave={(e) => { if (!responded) (e.currentTarget as HTMLElement).style.background = bg }}
          >
            {opt.label}
          </button>
        {/each}

        {#if queueLength > 1}
          <span class="text-xs sm:text-[0.625rem] px-2 py-0.5 rounded-full bg-(--solus-accent-light) text-(--solus-accent)">
            +{queueLength - 1} more
          </span>
        {/if}
      </div>
    </div>
  </div>
</div>
