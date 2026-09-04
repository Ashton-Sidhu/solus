<script lang="ts">
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";

  /** The same backend marks and treatment as the model picker. */
  interface Props {
    mark: "claude" | "codex" | null;
    size?: number;
    transparent?: boolean;
  }

  let { mark, size = 12, transparent = false }: Props = $props();

  /** The picker sits a 13px blossom on a 20px plate; keep that ratio at any size. */
  const plateSize = $derived(Math.round(size * (20 / 13)));
</script>

{#if mark === "claude"}
  <span class="flex shrink-0 items-center text-(--brand-claude)">
    <ClaudeIcon {size} />
  </span>
{:else if mark === "codex"}
  <span
    class="flex shrink-0 items-center justify-center {transparent
      ? 'text-(--solus-text-secondary)'
      : 'rounded-full bg-white'}"
    style="width:{plateSize}px;height:{plateSize}px"
  >
    <OpenAIBlossom {size} fill={transparent ? "currentColor" : "black"} />
  </span>
{/if}
