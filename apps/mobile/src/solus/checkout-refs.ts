import { projectContext } from "@solus-mobile/features/conversation/lib/ipc-context";
import type {
  EnvironmentId,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsRef,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { mobileHost } from "../state/mobile-host";
import { hostQuery } from "./host-query";
import { checkoutRepository } from "./checkout-git-queries";
import { solus } from "./runtime";

type RefRead = Pick<VcsListRefsInput, "cwd" | "refresh" | "includeMatchingRemoteRefs">;

const checkoutRefs = hostQuery(async (id, input: RefRead) => {
  const connection = solus.connections.connection(id);
  if (!connection || !solus.connections.may(id, "host.git.read"))
    throw new Error("This connection cannot read Git branches.");
  const api = connection.api;
  const context = projectContext(input.cwd, solus.account.organizationId);
  const listed = await api.worktreeBranches(context, { skipFetch: !input.refresh });
  const remotes = input.includeMatchingRemoteRefs
    ? await api.worktreeBranches(context, { remoteOnly: true, skipFetch: true })
    : [];
  return (
    input.includeMatchingRemoteRefs ? [...listed.filter((r) => !r.remoteOnly), ...remotes] : listed
  );
});

const checkout = Atom.family((key: string) => {
  const [environmentId, input]: [EnvironmentId, RefRead] = JSON.parse(key);
  const source = checkoutRefs({ environmentId, input });
  const repository = checkoutRepository({ environmentId, input: { cwd: input.cwd } });
  return Atom.readable(
    (get) => {
      const host = get(mobileHost(environmentId));
      if (host)
        get.addFinalizer(
          host.events.subscribe("git.checkoutChanged", ({ state }) => {
            if (state.cwd === input.cwd) get.refresh(source);
          }),
        );
      return AsyncResult.map(AsyncResult.all({ listed: get(source), repo: get(repository) }), ({ listed, repo }) => {
        const refs: VcsRef[] = listed.map((ref) => ({
          name: ref.name,
          current: ref.current ?? (!ref.remoteOnly && ref.name === repo.branch),
          isDefault: ref.isDefault,
          isRemote: ref.remoteOnly,
          worktreePath: ref.worktreePath ?? null,
        }));
        if (repo.branch && !refs.some((ref) => ref.current) && repo.isRepository) {
          refs.unshift({ name: repo.branch, current: true, isDefault: false, worktreePath: null });
        }
        const priority = (ref: VcsRef) => (ref.current ? 0 : ref.isDefault ? 1 : 2);
        refs.sort((a, b) => priority(a) - priority(b));
        return { refs, isRepo: repo.isRepository, hasPrimaryRemote: Boolean(repo.primaryRemoteName) };
      });
    },
    (refresh) => {
      refresh(source);
      refresh(repository);
    },
  );
});

const pages = Atom.family((key: string) => {
  const [id, input]: [EnvironmentId, VcsListRefsInput] = JSON.parse(key);
  const source = checkout(
    JSON.stringify([
      id,
      {
        cwd: input.cwd,
        refresh: input.refresh,
        includeMatchingRemoteRefs: input.includeMatchingRemoteRefs || input.refKind === "remote",
      },
    ]),
  );
  return Atom.map(source, (result) =>
    AsyncResult.map(result, ({ refs, isRepo, hasPrimaryRemote }): VcsListRefsResult => {
      const query = input.query?.trim().toLowerCase();
      const matching = refs.filter(
        (ref) =>
          (input.refKind !== "local" || !ref.isRemote) &&
          (input.refKind !== "remote" || ref.isRemote) &&
          (!query || ref.name.toLowerCase().includes(query)),
      );
      const start = input.cursor ?? 0;
      const page = matching.slice(start, start + (input.limit ?? 100));
      const end = start + page.length;
      return {
        refs: page,
        isRepo,
        hasPrimaryRemote,
        totalCount: matching.length,
        nextCursor: end < matching.length ? end : null,
      };
    }),
  );
});

export function listCheckoutRefs(target: {
  environmentId: EnvironmentId;
  input: VcsListRefsInput;
}) {
  return pages(JSON.stringify([target.environmentId, target.input]));
}
