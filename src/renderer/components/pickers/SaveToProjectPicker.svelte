<script lang="ts">
  import type { HostApi } from "@client-core/host-api";
  import type { IpcContext } from "../../../shared/types";
  import { toasts } from "../../lib/toasts";
  import DirectoryPicker from "./DirectoryPicker.svelte";
  import { projectSourcePath } from "./lib/project-source-file";

  interface Props {
    open: boolean;
    onClose: () => void;
    api: HostApi;
    serverId: string;
    ctx: IpcContext;
    projectRoot: string;
    fileName: string;
    content: string;
  }

  let { open, onClose, api, serverId, ctx, projectRoot, fileName, content }: Props = $props();
  let saving = $state(false);

  async function save(directory: string) {
    if (saving) return;
    saving = true;
    try {
      const result = await api.writeFile(ctx, {
        path: projectSourcePath(directory, fileName),
        cwd: projectRoot,
        contents: content,
      });
      if (!result.ok) {
        toasts.error("Couldn't save to project", { description: result.error });
        return;
      }
      toasts.success("Saved to project", { description: result.displayPath });
      onClose();
    } catch (error) {
      toasts.error("Couldn't save to project", {
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
  onSelect={(directory) => void save(directory)}
  initialPath={projectRoot}
  title="Save to project"
  actionLabel={saving ? "Saving…" : "Save here"}
  {api}
  {serverId}
/>
