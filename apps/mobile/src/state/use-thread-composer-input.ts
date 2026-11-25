import { useRef, useState } from "react";
import {
  endQueuedRunEdit,
  getQueuedRunEdit,
  queuedEditDraftKey,
  removeQueuedRunEditAttachment,
  startQueuedRunEditSave,
  useQueuedRunEdit,
} from "./queued-run-edit";
import { setComposerDraftText } from "./use-composer-drafts";

/** Thread and queued-edit callbacks resolve the active draft at the time of the action. */
export function useThreadComposerInput<K extends string | null>(threadKey: K, inputKey: K) {
  const queuedRunEdit = useQueuedRunEdit(threadKey);
  const composerDraftKey = threadKey && queuedRunEdit
    ? queuedEditDraftKey(threadKey, queuedRunEdit.runId)
    : inputKey;
  const saving = useRef(false);
  const [isSavingQueuedEdit, setSaving] = useState(false);

  function currentDraftKey() {
    const edit = threadKey === null ? null : getQueuedRunEdit(threadKey);
    return edit && threadKey ? queuedEditDraftKey(threadKey, edit.runId) : inputKey;
  }

  function beginQueuedEditSave() {
    if (threadKey === null || saving.current) return null;
    const finish = startQueuedRunEditSave(threadKey);
    if (!finish) return null;
    saving.current = true;
    setSaving(true);
    return (saved: boolean) => {
      saving.current = false;
      setSaving(false);
      return finish(saved);
    };
  }

  return {
    queuedRunEdit, composerDraftKey, currentDraftKey, beginQueuedEditSave, isSavingQueuedEdit,
    onChangeDraftMessage(value: string) {
      const key = currentDraftKey();
      if (key !== null) setComposerDraftText(key, value);
    },
    cancelQueuedRunEdit() {
      if (threadKey !== null && !saving.current) endQueuedRunEdit(threadKey);
    },
    onRemoveQueuedEditAttachment(id: string) {
      if (threadKey !== null) removeQueuedRunEditAttachment(threadKey, id);
    },
  };
}
