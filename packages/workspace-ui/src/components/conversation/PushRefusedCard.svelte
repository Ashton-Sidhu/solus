<script lang="ts">
  /**
   * Another host pushed this session first, so the cloud refused this host's
   * push (docs/plans/portable-sessions-cloud.md answer 3.4). Nothing is lost:
   * Fork keeps this machine's turns as a new session, and "Use the newer copy"
   * makes this host current with the cloud.
   */
  import { Button } from "../ui/button";

  interface Props {
    text: string;
    onFork: () => void;
    onUseNewerCopy: () => void;
  }

  let { text, onFork, onUseNewerCopy }: Props = $props();
</script>

<div role="status" class="my-3 flex flex-col gap-2 rounded-lg bg-(--card) px-3.5 py-3 text-workspace-chrome shadow-[shadow:var(--elev-ring)]">
  <p class="text-(--solus-text-primary)">{text}</p>
  <div class="flex flex-wrap gap-1.5">
    <Button size="sm" variant="secondary" onclick={onFork}>Fork</Button>
    <Button size="sm" variant="ghost" onclick={onUseNewerCopy}>Use the newer copy</Button>
  </div>
</div>
