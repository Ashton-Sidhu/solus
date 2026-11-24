import type { HostApi } from "@solus/client-core/host-api";
import { sameHostPath } from "@solus/contracts/host-path";
import type { EnvironmentId, VcsBranchStatus, VcsStatusResult } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { mobileHost } from "../state/mobile-host";
import { checkoutStatus } from "./checkout-git";
import { hostQuery } from "./host-query";
import { solus } from "./runtime";

type CheckoutTarget<Input> = { environmentId: EnvironmentId; input: Input };
type CheckoutPath = { cwd: string };
type CheckoutDetails = CheckoutPath & { includeDetails?: boolean };

function checkoutQuery<Input extends CheckoutPath, Value>(
  read: (api: HostApi, input: Input) => Promise<Value>,
) {
  const query = hostQuery((id, input: Input) => {
    const connection = solus.connections.connection(id);
    if (connection?.state.readiness !== "ready")
      throw new Error("Reconnect to this environment.");
    return read(connection.api, input);
  }, 0);
  const observed = Atom.family((key: string) => {
    const target: CheckoutTarget<Input> = JSON.parse(key);
    const source = query(target);
    return Atom.readable(
      (get) => {
        const host = get(mobileHost(target.environmentId));
        if (host) {
          get.addFinalizer(host.events.subscribe("git.checkoutChanged", ({ state }) => {
            if (sameHostPath(state.cwd, target.input.cwd)) get.refresh(source);
          }));
        }
        return get(source);
      },
      (refresh) => refresh(source),
    );
  });
  return (target: CheckoutTarget<Input>) => observed(JSON.stringify(target));
}

export const checkoutRepository = checkoutQuery((api, input: CheckoutPath) =>
  api.gitRepositoryStatus(input.cwd),
);
const details = checkoutQuery((api, input: CheckoutDetails) =>
  api.gitRefreshState(input.cwd, { includeDetails: input.includeDetails ?? true }),
);

const branch = Atom.family((key: string) => {
  const target: CheckoutTarget<CheckoutPath> = JSON.parse(key);
  const source = checkoutRepository(target);
  return Atom.readable(
    (get) => AsyncResult.map(get(source), (repo): VcsBranchStatus => ({
      refName: repo.branch,
      isRepo: repo.isRepository,
    })),
    (refresh) => refresh(source),
  );
});

const status = Atom.family((key: string) => {
  const target: CheckoutTarget<CheckoutDetails> = JSON.parse(key);
  const repo = checkoutRepository({ environmentId: target.environmentId, input: { cwd: target.input.cwd } });
  const state = details(target);
  return Atom.readable(
    (get): AsyncResult.AsyncResult<VcsStatusResult, Error> => {
      const result = AsyncResult.all({ repo: get(repo), state: get(state) });
      return AsyncResult.flatMap(result, ({ repo, state }) =>
        state && state.branch !== repo.branch
          ? AsyncResult.initial(true)
          : AsyncResult.success(checkoutStatus(repo, state), { waiting: result.waiting }),
      );
    },
    (refresh) => {
      refresh(repo);
      refresh(state);
    },
  );
});

export const checkoutVcsQueries = {
  branch: (target: CheckoutTarget<CheckoutPath>) => branch(JSON.stringify(target)),
  status: ({ environmentId, input: { cwd, includeDetails = true } }: CheckoutTarget<CheckoutDetails>) =>
    status(JSON.stringify({ environmentId, input: { cwd, includeDetails } })),
};
