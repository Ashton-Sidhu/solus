<script lang="ts">
  import type { HostApi } from "@solus/client-core/host-api";
  import type { IpcContext } from "@solus/contracts/types";
  import { toasts } from "../../lib/toasts";
  import DirectoryPicker from "./DirectoryPicker.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
    api: HostApi;
    serverId: string;
    ctx: IpcContext;
    /** Where browsing starts — the work's project when it has one. */
    initialPath: string;
    /** Seeds the picker's name field; the user can change it before saving. */
    fileName: string;
    /** UTF-8 text, or base64 bytes when `encoding` says so. */
    content: string;
    encoding?: "utf8" | "base64";
    title?: string;
  }

  let {
    open,
    onClose,
    api,
    serverId,
    ctx,
    initialPath,
    fileName,
    content,
    encoding = "utf8",
    title = "Save a copy",
  }: Props = $props();

  let saving = $state(false);

  async function save(path: string) {
    if (saving) return;
    saving = true;
    try {
      // The destination is one the user just chose by hand, so it is not
      // confined to a project the way an in-tree editor save is.
      const result = await api.writeFile(ctx, { path, contents: content, encoding, destination: "host" });
      if (!result.ok) {
        toasts.error("Couldn't save the file", { description: result.error });
        return;
      }
      toasts.success("Saved", { description: result.displayPath });
      onClose();
    } catch (error) {
      toasts.error("Couldn't save the file", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      saving = false;
    }
  }
</script>

<DirectoryPicker
  {open}
  {onClose}
  onSelect={(path) => void save(path)}
  {initialPath}
  {title}
  {fileName}
  actionLabel={saving ? "Saving…" : "Save"}
  {api}
  {serverId}
/>
