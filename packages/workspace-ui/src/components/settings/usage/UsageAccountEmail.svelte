<script lang="ts">
  import { maskEmail } from "@solus/client-core/usage-limits";

  interface Props {
    email: string;
    class?: string;
  }

  let { email, class: className = "" }: Props = $props();
  let revealed = $state(false);
</script>

{#if email.includes("@")}
  <button
    type="button"
    onclick={() => (revealed = !revealed)}
    aria-pressed={revealed}
    aria-label={revealed ? "Hide account email" : "Reveal account email"}
    title={revealed ? "Click to hide email" : "Click to reveal email"}
    class="cursor-pointer truncate rounded-sm text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring {className}"
  >
    {revealed ? email : maskEmail(email)}
  </button>
{:else}
  <span class="truncate text-xs text-muted-foreground {className}">{email}</span>
{/if}
