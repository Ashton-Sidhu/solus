import type { AgentId, PlanReference, ReasoningEffort, WorkReference } from "../../../../shared/types";

export { default as PromptComposer } from "./prompt-composer.svelte";
export type { PickerSelection } from "../../pickers/lib/picker-selection";

/** Everything a host needs to dispatch: the note plus the picked target. */
export interface PromptComposerSubmit {
  text: string;
  provider: AgentId;
  modelId: string | null;
  reasoningEffort: ReasoningEffort;
  planRefs: PlanReference[];
  workRefs: WorkReference[];
}
