<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import DocumentEditor from "../editor/DocumentEditor.svelte";
  import { MentionPicker } from "../mentions/lib/mention-picker.svelte";
  import { createMentionPickerExtension, tiptapMentionEditor } from "../mentions/lib/tiptap-mention-picker";
  import { codeHostMentionSource, getCodeHostMentions } from "../mentions/lib/code-host-mentions";
  import MentionPickerMenu from "../mentions/MentionPickerMenu.svelte";

  // The pull request description, edited in place. `@` names a GitHub account
  // and writes `@login`, the same as in the comments below it.
  let { value, onValueChange }: { value: string; onValueChange: (markdown: string) => void } = $props();

  let documentEditor = $state<DocumentEditor | null>(null);
  let tiptapEditor: Editor | null = null;
  const codeHostMentions = getCodeHostMentions();
  const mentionPicker = codeHostMentions
    ? new MentionPicker({
        source: codeHostMentionSource(codeHostMentions),
        editor: () => (tiptapEditor && !tiptapEditor.isDestroyed ? tiptapMentionEditor(tiptapEditor) : null),
      })
    : null;

  /** The markdown now, with no wait for the debounced `onValueChange`. */
  export function getCurrentMarkdown(): string {
    return documentEditor?.getCurrentMarkdown() ?? value;
  }
</script>

<DocumentEditor
  bind:this={documentEditor}
  {value}
  {onValueChange}
  extraExtensions={mentionPicker ? [createMentionPickerExtension(mentionPicker)] : []}
  onEditorReady={(editor) => (tiptapEditor = editor)}
  placeholder="Describe this pull request…"
  dictation
  dragHandle={false}
  class="pr-description-editor prose-pr prose-pr-description"
  style="max-height:26.25rem;overflow-y:auto"
/>

{#if mentionPicker}
  <MentionPickerMenu picker={mentionPicker} />
{/if}
