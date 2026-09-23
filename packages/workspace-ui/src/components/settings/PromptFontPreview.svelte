<script lang="ts">
  /** The box you write prompts in: the input bar's own editor, under the same
   *  face, size, leading, and weight variables `InputBar.svelte` sets on its
   *  well, so typing here feels exactly like typing there. The draft is local
   *  and goes nowhere. */
  import { PlainTextEditor } from "../ui/plain-text-editor";
  import { PROMPT_PREVIEW } from "./lib/font-preview-samples";

  let draft = $state(PROMPT_PREVIEW);
</script>

<div
  class="rounded-lg border border-border bg-card px-3.5 [--plain-editor-font-size:var(--solus-prompt-font-size)] [font-family:var(--solus-prompt-font-family)] [--plain-editor-line-height:1.625] [--solus-font-weight-body:var(--solus-font-weight-user-content)] [--plain-editor-padding:0.75rem_0]"
>
  <PlainTextEditor
    value={draft}
    onValueChange={(value) => (draft = value)}
    ariaLabel="Prompt font preview"
    placeholder="Type to try the prompt font"
    enterInsertsNewline
    maxHeight={120}
  />
</div>
