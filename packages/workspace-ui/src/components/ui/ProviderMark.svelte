<script lang="ts">
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";
  import type { ProviderMarkId } from "../insights/lib/provider";

  /** The same backend marks and treatment as the model picker. */
  interface Props {
    mark: ProviderMarkId;
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
{:else if mark === "antigravity"}
  <!-- An arch that lifts off its base: Solus's own mark for Antigravity, not Google's logo. -->
  <span class="flex shrink-0 items-center {transparent ? '' : 'text-(--solus-text-secondary)'}">
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 13.5V8a5 5 0 0 1 10 0v5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <path d="M6 13.5V8.5a2 2 0 0 1 4 0v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    </svg>
  </span>
{/if}
