import type { AgentId } from '@solus/contracts/types'
import type { SessionDraft } from '../../../contexts/workspace/session-draft.svelte'
import type { PickerSelection } from '../../pickers/lib/picker-selection'

/**
 * The model chip's detached selection over a draft's run. A draft has no
 * session for the chip to edit, so the agent, model, and effort picked before
 * Send are written straight into the run the session will start with.
 *
 * Both composers a draft can appear in — the editor's draft pane and the pill's
 * dock — read the draft through a getter, so the selection follows whichever
 * draft is on screen without being rebuilt.
 */
export function draftModelSelection(
  draft: () => SessionDraft | null,
  defaultProvider: () => AgentId,
): PickerSelection {
  return {
    get provider() {
      return draft()?.run.provider ?? defaultProvider()
    },
    set provider(next) {
      const current = draft()
      if (current) current.run = { ...current.run, provider: next }
    },
    get modelId() {
      return draft()?.run.modelConfig?.modelId ?? null
    },
    set modelId(next) {
      const current = draft()
      if (!current) return
      current.run = {
        ...current.run,
        modelConfig: { ...current.run.modelConfig, modelId: next },
      }
    },
    get reasoningEffort() {
      return draft()?.run.modelConfig?.reasoningEffort ?? 'high'
    },
    set reasoningEffort(next) {
      const current = draft()
      if (!current) return
      current.run = {
        ...current.run,
        modelConfig: { ...current.run.modelConfig, reasoningEffort: next },
      }
    },
  }
}
