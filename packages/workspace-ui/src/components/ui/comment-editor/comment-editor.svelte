<script lang="ts">
  import PlainTextEditor from "../plain-text-editor/plain-text-editor.svelte";

  interface Props {
    value: string;
    onValueChange: (value: string) => void;
    onKeyDown?: (event: KeyboardEvent) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    placeholder?: string;
    hidePlaceholderOnFocus?: boolean;
    disabled?: boolean;
    maxHeight?: number;
    class?: string;
    style?: string;
  }

  let {
    value,
    onValueChange,
    onKeyDown,
    onFocus,
    onBlur,
    placeholder = "",
    hidePlaceholderOnFocus = true,
    disabled = false,
    maxHeight = 160,
    class: klass = "",
    style = "",
  }: Props = $props();

  let editor: ReturnType<typeof PlainTextEditor> | null = $state(null);

  export function focus() {
    editor?.focus();
  }
</script>

<PlainTextEditor
  bind:this={editor}
  {value}
  {onValueChange}
  {onKeyDown}
  {onFocus}
  {onBlur}
  {placeholder}
  {hidePlaceholderOnFocus}
  {disabled}
  {maxHeight}
  enterInsertsNewline
  class={klass}
  {style}
/>

