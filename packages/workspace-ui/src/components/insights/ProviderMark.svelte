<script lang="ts">
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";
  import type { ProviderMarkId } from "./lib/provider";

  /**
   * A backend's logo, beside its written name.
   *
   * The marks are the ones the model picker in the input bar draws — Claude's
   * glyph and OpenAI's blossom — so a backend looks the same wherever Solus
   * names it.
   *
   * Each is drawn the way the picker draws it: Claude in the terracotta the
   * session picker and the onboarding cards already use, and Codex as its solid
   * black blossom on a white plate, which is the only way that mark stays
   * legible in dark mode. The plate scales with the glyph on the same ratio the
   * picker uses, so a small mark keeps the disc proportionate.
   *
   * Nothing is drawn for a backend Solus does not recognise. The caller words
   * that case, because "Unknown", "unknown provider", and "Agent" are each
   * right on a different surface.
   */
  interface Props {
    mark: ProviderMarkId;
    size?: number;
  }

  let { mark, size = 12 }: Props = $props();

  /** The picker sits a 13px blossom on a 20px plate; keep that ratio at any size. */
  const plateSize = $derived(Math.round(size * (20 / 13)));
</script>

{#if mark === "claude"}
  <span class="flex shrink-0 items-center text-(--brand-claude)">
    <ClaudeIcon {size} />
  </span>
{:else if mark === "codex"}
  <span
    class="flex shrink-0 items-center justify-center rounded-full bg-white"
    style="width:{plateSize}px;height:{plateSize}px"
  >
    <OpenAIBlossom {size} />
  </span>
{/if}
