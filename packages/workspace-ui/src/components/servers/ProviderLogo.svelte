<script lang="ts">
  import Icon from "@iconify/svelte";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import { ensureIconCollections } from "../diagram/iconify";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";
  import { PROVIDER_LOGOS } from "../settings/lib/provider-logos";
  import type { ProviderLogoId } from "./lib/host-onboarding";

  interface Props {
    provider: ProviderLogoId;
  }

  let { provider }: Props = $props();

  ensureIconCollections();
</script>

<!-- The marks the model picker draws, bare: Claude keeps its own colour, and
     the monochrome GitHub and OpenAI marks take the text colour so they hold
     in both themes. -->
<span class="flex size-5 shrink-0 items-center justify-center text-foreground" aria-hidden="true">
  {#if provider === "github"}
    <Icon icon={PROVIDER_LOGOS.github} width={18} height={18} />
  {:else if provider === "claude"}
    <span class="flex text-(--brand-claude)"><ClaudeIcon size={18} /></span>
  {:else}
    <OpenAIBlossom size={17} fill="currentColor" />
  {/if}
</span>
