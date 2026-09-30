<script lang="ts">
  interface Props {
    onRetry: () => void;
    onDownload: () => void;
  }

  let { onRetry, onDownload }: Props = $props();
</script>

<div class="diagram-load-error" role="alert" data-testid="diagram-load-error">
  <div class="diagram-load-error__copy">
    <p class="diagram-load-error__title">This diagram could not be read.</p>
    <p class="diagram-load-error__detail">
      The source is still available. Retry after it changes, or download it for repair.
    </p>
  </div>
  <div class="diagram-load-error__actions">
    <button type="button" class="diagram-load-error__button" onclick={onRetry}>
      Try again
    </button>
    <button type="button" class="diagram-load-error__button" onclick={onDownload}>
      Download JSON
    </button>
  </div>
</div>
