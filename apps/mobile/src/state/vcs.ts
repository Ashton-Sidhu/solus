import { listCheckoutRefs } from "../solus/checkout-refs";
import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = {
  ...createVcsEnvironmentAtoms(connectionAtomRuntime),
  listRefs: listCheckoutRefs,
};
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
