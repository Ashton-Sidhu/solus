<script lang="ts">
  interface Props {
    onAddNode: () => void;
  }

  let { onAddNode }: Props = $props();
</script>

<div class="diagram-empty">
  <div class="diagram-empty__card">
    <svg
      viewBox="0 0 16 16"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="3" width="6" height="4.5" rx="1" />
      <rect x="8.5" y="8.5" width="6" height="4.5" rx="1" />
      <path d="M4.5 7.5v1.5a1 1 0 001 1h3" />
    </svg>
    <p class="diagram-empty__title">No nodes yet</p>
    <p class="diagram-empty__hint">
      Add a node to start building your diagram.
    </p>
    <button
      type="button"
      class="diagram-btn diagram-empty__cta"
      onclick={onAddNode}>Add node</button
    >
  </div>
</div>
