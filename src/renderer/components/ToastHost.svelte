<script lang="ts">
  import Toast from "./Toast.svelte";
  import { toasts } from "../contexts/toast.store.svelte";
</script>

<!-- Single host for the app-wide toast. Mounted inside each shell so the toast
     stays within the visible bounds (top-right); only the active shell renders
     one. The {#key} re-arms the dismiss timer whenever a new toast appears. -->
{#if toasts.current}
  {#key toasts.current.id}
    <Toast
      message={toasts.current.message}
      variant={toasts.current.variant}
      actionLabel={toasts.current.action?.label}
      duration={toasts.current.duration}
      placement="top"
      onAction={() => toasts.runAction()}
      onDismiss={() => toasts.dismiss()}
    />
  {/key}
{/if}
