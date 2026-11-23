import { createAtomCommandScheduler } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { hostQueryScope } from "../state/host-query-scope";
import { HostOperationError } from "./host-operation-error";
import { solus } from "./runtime";

type Permission = "host.use" | "host.git.write";
const canWrite = Atom.family((permission: Permission) =>
  Atom.family((id: EnvironmentId) =>
    Atom.make((get) => {
      const read = () => solus.connections.may(id, permission);
      get.addFinalizer(solus.connections.changes.subscribe(() => get.setSelf(read())));
      return read();
    }),
  ),
);
const writes = createAtomCommandScheduler();

export function hostCommand<I>(
  label: string,
  permission: Permission,
  write: (
    id: EnvironmentId,
    input: I,
    registry: AtomRegistry.AtomRegistry,
    check: () => void,
  ) => Promise<void>,
) {
  return {
    label,
    permissionAtom: canWrite(permission),
    run(registry: AtomRegistry.AtomRegistry, target: { environmentId: EnvironmentId; input: I }) {
      const { environmentId, input } = target;
      const scope = hostQueryScope(environmentId);
      const check = () => {
        if (
          hostQueryScope(environmentId) !== scope ||
          !solus.connections.may(environmentId, permission)
        )
          throw new HostOperationError({
            message: "This connection can no longer make this change.",
          });
      };
      return writes.schedule(
        registry,
        { mode: "serial", key: () => environmentId },
        target,
        Effect.tryPromise({
          try: () => {
            check();
            return write(environmentId, input, registry, check);
          },
          catch: HostOperationError.from,
        }).pipe(Effect.uninterruptible),
      );
    },
  };
}
