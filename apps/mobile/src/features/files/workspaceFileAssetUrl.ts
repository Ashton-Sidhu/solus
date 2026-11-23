import type { EnvironmentId } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentQuery } from "../../state/query";
import { checkoutAssetUrl } from "../../solus/checkout-files";

export function useWorkspaceFileAssetUrlState(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  path: string | null,
  accountKey: string,
) {
  const atom =
    environmentId && cwd && path
      ? checkoutAssetUrl({ environmentId, accountKey, input: { cwd, path } })
      : null;
  const result = useEnvironmentQuery(atom);
  return {
    uri: result.data,
    failed: result.error !== null,
    refresh: result.refresh,
    resolve: async () => {
      if (!atom) return null;
      const signed = await executeAtomQuery(appAtomRegistry, atom, {
        refresh: true,
        reportFailure: false,
      });
      return signed._tag === "Success" ? signed.value : null;
    },
  };
}
