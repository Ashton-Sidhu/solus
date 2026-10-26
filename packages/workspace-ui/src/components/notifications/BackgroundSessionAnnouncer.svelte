<script lang="ts">
  import { notificationsStore } from "../../contexts/notifications/notifications.store.svelte";

  // Speaks status changes of sessions the user is not looking at. It sits
  // outside the sidebar, so a collapsed sidebar does not silence it. Two
  // regions take turns, so the same words said twice in a row are spoken twice.
  let regions = $state(["", ""]);

  $effect(() => {
    const { text, count } = notificationsStore.spoken;
    if (count === 0) return;
    regions = count % 2 === 0 ? [text, ""] : ["", text];
    // Old words left in a region can be read again later (NVDA reads them when
    // a dialog closes), and an old "Done" then sounds new.
    const timer = setTimeout(() => (regions = ["", ""]), 7000);
    return () => clearTimeout(timer);
  });
</script>

<!-- No role="status": Orca maps it to a status bar in Chromium and drops its updates. -->
<div class="sr-only" aria-live="polite">{regions[0]}</div>
<div class="sr-only" aria-live="polite">{regions[1]}</div>
