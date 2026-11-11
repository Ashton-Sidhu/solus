<script lang="ts">
  import { untrack } from "svelte";
  import { hosts } from "../../contexts/hosts/hosts.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { voiceModelToast } from "./lib/voice-model-toast";

  /**
   * Says, in one toast, that the transcription host prepares its voice model
   * or that the download failed. A toast and not a banner: the notice is about
   * dictation only, so it must not take a row from every page.
   */
  const TOAST_ID = "voice-model";
  // The toast sits over the controls of the page header, so it never stays.
  // A failure stays longer, to give time to read it and to choose Retry; the
  // dictation control keeps the state after the toast is gone.
  const FAILURE_TOAST_MS = 10_000;

  const host = $derived(hosts.transcription);
  const state = $derived(host?.capabilityRecord?.voiceModel === true ? host.voiceStatus.state : null);

  // A toast is a side effect of the state, so a derivation cannot express it.
  // One toast per state: after it closes, a person does not see it again
  // until the state changes.
  $effect(() => {
    const notice = voiceModelToast(state);
    untrack(() => {
      if (!notice) {
        toasts.dismiss(TOAST_ID);
        return;
      }
      toasts.show({
        id: TOAST_ID,
        message: notice.message,
        description: notice.description,
        variant: notice.variant,
        duration: notice.canRetry ? FAILURE_TOAST_MS : undefined,
        closeButton: true,
        action: notice.canRetry
          ? {
              label: "Retry",
              onAction: () => {
                void host?.retryVoiceModel();
                requestInputFocus();
              },
            }
          : undefined,
      });
    });
  });

  // The toast leaves with the workspace. This is not the cleanup of the effect
  // above: that one would close the toast before each new state shows it.
  $effect(() => () => {
    toasts.dismiss(TOAST_ID);
  });
</script>
