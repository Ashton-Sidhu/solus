<script lang="ts">
  import { GithubLogoIcon, OpenAiLogoIcon } from "phosphor-svelte";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import type { ProviderLogoId } from "./lib/host-onboarding";

  interface Props {
    provider: ProviderLogoId;
  }

  let { provider }: Props = $props();

  // A brand keeps its own colour where it has one. The marks that are
  // monochrome by design borrow the text colour instead, so they hold up in
  // both themes rather than being pinned to one background.
  const TINTS: Record<ProviderLogoId, string> = {
    github: "var(--solus-text-primary)",
    claude: "#c15f2c",
    codex: "var(--solus-text-primary)",
  };
</script>

<span
  class="flex size-[1.6875rem] shrink-0 items-center justify-center rounded-[0.5rem] bg-[color-mix(in_srgb,var(--tint)_12%,transparent)] text-[var(--tint)] shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--tint)_18%,transparent)]"
  style="--tint: {TINTS[provider]}"
  aria-hidden="true"
>
  {#if provider === "github"}
    <GithubLogoIcon size={14} weight="fill" />
  {:else if provider === "claude"}
    <ClaudeIcon size={13} />
  {:else}
    <OpenAiLogoIcon size={14} />
  {/if}
</span>
