<script lang="ts">
  import { Play } from "@lucide/svelte";
  import { deviceViewState } from "./lib/device-view-state.svelte";
  interface Props { serverId: string }
  let { serverId }: Props = $props();
</script>
<button type="button" class="flex size-8 items-center justify-center rounded-full text-(--solus-text-secondary) hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)" aria-label="Run app" title="Run app" onclick={() => deviceViewState.showRunApp(serverId, true)}><Play class="size-4" /></button>
