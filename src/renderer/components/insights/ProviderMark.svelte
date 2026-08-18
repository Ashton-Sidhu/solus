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
   * Each is drawn in the brand's own ink: Claude in the terracotta the session
   * picker and the onboarding cards already use, and Codex in the blue of its
   * app icon — the same hue its bar carries on the volume histogram, so one
   * colour names one backend across the page. The picker sets the blossom on a
   * white plate because it draws the mark in solid black; at caption size a
   * white disc would outweigh the glyph, so the mark takes the ink instead.
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
</script>

{#if mark === "claude"}
  <span class="flex shrink-0 items-center text-(--brand-claude)">
    <ClaudeIcon {size} />
  </span>
{:else if mark === "codex"}
  <span class="flex shrink-0 items-center text-(--brand-codex)">
    <OpenAIBlossom {size} fill="currentColor" />
  </span>
{/if}
