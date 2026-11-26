import { expect, it, vi } from "vite-plus/test";
import type { AddMachineCandidate } from "@solus/client-core/add-machine-candidates";
import type { SshAddRequest, SshAddResult } from "@solus/contracts/remote-machines";
import {
  ANOTHER_SSH,
  attemptAddMachine,
  chosenIdentityFile,
  fixKeyThenAdd,
  initialChoice,
  typedSshStep,
  type AddMachineDeps,
} from "@solus-mobile/features/conversation/lib/add-machine-card";
import {
  fixKeyAndRunSshAdd,
  runSshAdd,
  sshAddOutcome,
  type SshAddConnection,
  type SshAddForm,
} from "@solus-mobile/features/hosts/lib/ssh-add";

// An SSH add from the phone (the Add machine card and Add over SSH): the
// target and key the person typed reach the host that runs SSH, a key that
// other users can read is fixed only on request, and a password goes only into
// the add that the host asked for it.

const linked: SshAddResult = { status: "linked", installationId: "box", label: "Box" };
const tooOpen: SshAddResult = {
  status: "key-permissions",
  identityFile: "~/.ssh/aws.pem",
  message: "Other users can read ~/.ssh/aws.pem, so ssh refuses it.",
};

function sessionHost(results: SshAddResult[]) {
  const requests: SshAddRequest[] = [];
  const calls: string[] = [];
  const session: AddMachineDeps["session"] = {
    hostsAddOverSsh: vi.fn(async (request: SshAddRequest) => {
      requests.push(request);
      calls.push("add");
      const next = results.shift();
      if (!next) throw new Error("No answer left");
      return next;
    }),
    hostsPair: vi.fn(),
  };
  return { session, requests, calls };
}

const alias = (target: string): AddMachineCandidate => ({
  key: `ssh:${target}`,
  label: target,
  detail: target,
  way: "ssh",
  minted: false,
  sshTarget: target,
  isMatch: false,
});

it("sends the typed target and key in the SSH request of the card", async () => {
  const host = sessionHost([linked]);
  const step = typedSshStep(" ubuntu@3.91.20.4 ");
  expect(step).toEqual({ kind: "ssh", sshTarget: "ubuntu@3.91.20.4", name: "ubuntu@3.91.20.4" });
  const identityFile = chosenIdentityFile(ANOTHER_SSH, { identityFile: " ~/.ssh/aws.pem ", useAnotherKey: false });
  const attempt = await attemptAddMachine(
    { session: host.session, target: () => null, deviceLabel: "Laptop" },
    step!,
    { requestId: "r1", identityFile },
  );
  expect(attempt.kind).toBe("added");
  expect(host.requests[0]).toEqual({
    sshTarget: "ubuntu@3.91.20.4",
    identityFile: "~/.ssh/aws.pem",
    requestId: "r1",
    deviceLabel: "Laptop",
  });
});

it("uses the key of ~/.ssh/config on an alias until the person chooses another key", () => {
  expect(chosenIdentityFile("ssh:box", { identityFile: "~/.ssh/aws.pem", useAnotherKey: false })).toBeUndefined();
  expect(chosenIdentityFile("ssh:box", { identityFile: "~/.ssh/aws.pem", useAnotherKey: true })).toBe("~/.ssh/aws.pem");
  expect(chosenIdentityFile(ANOTHER_SSH, { identityFile: "  ", useAnotherKey: false })).toBeUndefined();
});

it("selects the alias that the agent's target names, else the typed SSH row", () => {
  const candidates = [alias("work"), alias("box")];
  expect(initialChoice({ reason: "", sshTarget: "box" }, candidates)).toBe("ssh:box");
  expect(initialChoice({ reason: "", sshTarget: "ubuntu@3.91.20.4" }, candidates)).toBe(ANOTHER_SSH);
  expect(initialChoice({ reason: "" }, candidates)).toBe("ssh:work");
});

it("fixes a key that other users can read only on request, in the same add with the same key", async () => {
  const host = sessionHost([tooOpen, linked]);
  const deps = { session: host.session, target: () => null, deviceLabel: "Laptop" };
  const step = typedSshStep("ubuntu@3.91.20.4")!;
  const input = { requestId: "r1", identityFile: "~/.ssh/aws.pem" };

  const first = await attemptAddMachine(deps, step, input);
  expect(first).toEqual({ kind: "key-permissions", identityFile: "~/.ssh/aws.pem", message: tooOpen.message });
  expect(host.calls).toEqual(["add"]);

  const second = await fixKeyThenAdd(deps, step, { ...input, requestId: "r2" });
  expect(second.kind).toBe("added");
  expect(host.calls).toEqual(["add", "add"]);
  expect(host.requests[0]).not.toHaveProperty("fixIdentityFilePermissions");
  expect(host.requests[1]).toMatchObject({ identityFile: "~/.ssh/aws.pem", fixIdentityFilePermissions: true });
});

it("shows a missing key under the identity file field", async () => {
  const host = sessionHost([]);
  vi.mocked(host.session.hostsAddOverSsh).mockRejectedValueOnce(
    new Error("No file at ~/.ssh/aws.pem on Laptop. Choose the private key on Laptop."),
  );
  const attempt = await attemptAddMachine(
    { session: host.session, target: () => null, deviceLabel: "Laptop" },
    typedSshStep("box")!,
    { requestId: "r1", identityFile: "~/.ssh/aws.pem" },
  );
  expect(attempt).toMatchObject({ kind: "failed", field: "identityFile" });

  vi.mocked(host.session.hostsAddOverSsh).mockRejectedValueOnce(new Error("ssh: connect to host box port 22: timed out"));
  const other = await attemptAddMachine(
    { session: host.session, target: () => null, deviceLabel: "Laptop" },
    typedSshStep("box")!,
    { requestId: "r2" },
  );
  expect(other).toEqual({ kind: "failed", message: "ssh: connect to host box port 22: timed out" });
});

// Add over SSH on the Add environment screen.

function runnerHost(results: SshAddResult[]) {
  const requests: SshAddRequest[] = [];
  const calls: string[] = [];
  const connection: SshAddConnection = {
    api: {
      hostsAddOverSsh: vi.fn(async (request: SshAddRequest) => {
        requests.push(request);
        calls.push("add");
        return results.shift() ?? linked;
      }),
    },
    events: { subscribe: () => () => {} },
  };
  return { connection, requests, calls };
}

const form = (patch: Partial<SshAddForm> = {}): SshAddForm => ({
  runnerHostId: "laptop",
  sshTarget: "ubuntu@3.91.20.4",
  identityFile: "~/.ssh/aws.pem",
  shouldLink: false,
  authSecret: "",
  ...patch,
});

const options = (requestId: string) => ({
  requestId,
  deviceLabel: "Laptop",
  issueTicket: async () => null,
  onProgress: () => {},
});

it("sends the password only in the add that follows the host's request for it", async () => {
  const host = runnerHost([{ status: "needs-auth", sshTarget: "ubuntu@3.91.20.4", message: "SSH refused the key." }, linked]);
  const first = await runSshAdd(host.connection, form(), options("r1"));
  expect(sshAddOutcome(first, "Laptop").kind).toBe("ask-auth");
  expect(host.requests[0]).not.toHaveProperty("authSecret");
  expect(host.requests[0]?.identityFile).toBe("~/.ssh/aws.pem");

  await runSshAdd(host.connection, form({ authSecret: "hunter2" }), options("r2"));
  expect(host.requests[1]?.authSecret).toBe("hunter2");
});

it("turns key-permissions into Fix permissions, which asks the host to fix the key in the second add", async () => {
  const host = runnerHost([tooOpen, linked]);
  const first = await runSshAdd(host.connection, form(), options("r1"));
  expect(sshAddOutcome(first, "Laptop")).toEqual({
    kind: "fix-key",
    identityFile: "~/.ssh/aws.pem",
    message: tooOpen.message,
  });
  const second = await fixKeyAndRunSshAdd(host.connection, form(), options("r2"));
  expect(sshAddOutcome(second, "Laptop").kind).toBe("linked");
  expect(host.calls).toEqual(["add", "add"]);
  expect(host.requests[0]).not.toHaveProperty("fixIdentityFilePermissions");
  expect(host.requests[1]?.fixIdentityFilePermissions).toBe(true);
});
