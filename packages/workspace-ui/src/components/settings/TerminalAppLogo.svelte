<script lang="ts">
  import { getSettingsContext, toolsStore } from "../../contexts";
  import AppLogo from "./AppLogo.svelte";

  interface Props {
    size?: number;
  }

  let { size = 13 }: Props = $props();

  const settings = getSettingsContext();

  // Which terminal opens depends on whether one is already attached to the
  // shared tmux session, so the answer is re-asked rather than cached: it
  // changes whenever the user opens or quits a terminal outside Solus.
  $effect(() => {
    void toolsStore.refreshResolvedTerminal(settings.fallbackTerminal);
  });

  const resolved = $derived(toolsStore.resolvedTerminal);
</script>

<AppLogo
  id={resolved?.id ?? settings.fallbackTerminal ?? "default-terminal"}
 
  name={resolved?.name}
  kind="terminal"
  {size}
/>
