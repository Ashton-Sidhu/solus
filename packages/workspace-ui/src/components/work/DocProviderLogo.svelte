<script lang="ts">
  import Icon from "@iconify/svelte";
  import type { DocProviderId } from "@solus/contracts/docs";
  import { ensureIconCollections } from "../diagram/iconify";
  import { docProviderLabel, docProviderLogo } from "./lib/work-publish";

  interface Props {
    provider: DocProviderId;
    size?: number;
  }

  let { provider, size = 13 }: Props = $props();

  ensureIconCollections();

  const label = $derived(docProviderLabel(provider));
</script>

<span
  class="inline-flex shrink-0 items-center justify-center"
  role="img"
  aria-label={label}
  title={label}
>
  <Icon icon={docProviderLogo(provider)} width={size} height={size} aria-hidden="true" />
</span>
