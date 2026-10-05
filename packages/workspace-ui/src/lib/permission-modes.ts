import { FilePenLine, Lock, LockOpen, ListTodo, Sparkles } from '@lucide/svelte'
import type { PermissionMode } from '@solus/contracts/types'

/** How each permission mode reads in the picker, Settings, and the phone's mode control. */
export const PERMISSION_MODE_DISPLAY = {
  supervised: { label: 'Supervised', shortLabel: 'Ask', description: 'Ask before commands and edits', icon: Lock },
  'accept-edits': { label: 'Accept edits', shortLabel: 'Edits', description: 'Edit files, ask before commands', icon: FilePenLine },
  auto: { label: 'Auto', shortLabel: 'Auto', description: 'Approve routine actions', icon: Sparkles },
  'full-access': { label: 'Full access', shortLabel: 'Full', description: 'Never ask for approval', icon: LockOpen },
  plan: { label: 'Plan', shortLabel: 'Plan', description: 'Read only, propose a plan', icon: ListTodo },
} satisfies Record<PermissionMode, { label: string; shortLabel: string; description: string; icon: typeof Lock }>
