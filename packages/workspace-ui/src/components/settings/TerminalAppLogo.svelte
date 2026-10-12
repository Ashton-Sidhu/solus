<script lang="ts">
  import { getSettingsContext, toolsStore } from "../../contexts";
  import AppLogo from "./AppLogo.svelte";

  interface Props {
    size?: number;
  }

  let { size = 13 }: Props = $props();

  const settings = getSettingsContext();
  const resolved = $derived(toolsStore.resolvedTerminal);
</script>

<AppLogo
  id={resolved ? resolved.id : (settings.fallbackTerminal ?? "default-terminal")}
  name={resolved?.name}
  kind="terminal"
  {size}
/>
