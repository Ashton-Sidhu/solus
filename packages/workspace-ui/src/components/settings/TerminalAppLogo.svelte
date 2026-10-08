<script lang="ts">
  import { toolsStore } from "../../contexts";
  import AppLogo from "./AppLogo.svelte";

  interface Props {
    size?: number;
  }

  let { size = 13 }: Props = $props();

  const resolved = $derived(toolsStore.resolvedTerminal);
</script>

<AppLogo
  id={resolved?.id ?? null}
  name={resolved?.name}
  kind="terminal"
  {size}
/>
