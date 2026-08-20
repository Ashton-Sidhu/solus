<script lang="ts">
  import PlainTextEditor from "../plain-text-editor/plain-text-editor.svelte";

  interface Props {
    value: string;
    onValueChange: (value: string) => void;
    onInput?: () => void;
    onEmptyChange?: (empty: boolean) => void;
    onKeyDown?: (event: KeyboardEvent) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    placeholder?: string;
    disabled?: boolean;
    maxHeight?: number;
    class?: string;
    style?: string;
  }

  let {
    value,
    onValueChange,
    onInput,
    onEmptyChange,
    onKeyDown,
    onFocus,
    onBlur,
    placeholder = "",
    disabled = false,
    maxHeight = 160,
    class: klass = "",
    style = "",
  }: Props = $props();

  let editor: ReturnType<typeof PlainTextEditor> | null = $state(null);

  export function focus() {
    editor?.focus();
  }

  export function getMarkdown(): string {
    return value;
  }

</script>

<PlainTextEditor
  bind:this={editor}
  {value}
  {onValueChange}
  {onInput}
  {onEmptyChange}
  {onKeyDown}
  {onFocus}
  {onBlur}
  {placeholder}
  {disabled}
  {maxHeight}
  enterInsertsNewline
  class={klass}
  {style}
/>
