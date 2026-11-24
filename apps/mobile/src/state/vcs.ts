import { listCheckoutRefs } from "../solus/checkout-refs";
import { checkoutVcsQueries } from "../solus/checkout-git-queries";
import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = {
  ...createVcsEnvironmentAtoms(connectionAtomRuntime),
  ...checkoutVcsQueries,
  listRefs: listCheckoutRefs,
};
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
