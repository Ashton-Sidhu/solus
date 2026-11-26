import { expect, it } from "vite-plus/test";
import { HostPolicies } from "@solus/contracts/host-policies";
import type { PolicyDocument } from "@solus/contracts/policy";
import { policyScreenModel } from "./policy-view";

function limitsOf(limits: NonNullable<NonNullable<PolicyDocument["sessions"]>["limits"]>) {
  const document: PolicyDocument = { schemaVersion: 1, organization: { name: "Globex" }, sessions: { limits } };
  const policies = new HostPolicies({
    mdm: null,
    hostOwnerOrganizationId: null,
    organizations: {
      globex: { state: "ready", policy: { kind: "organization", organizationId: "globex", document }, hostPolicy: null },
    },
  });
  return policyScreenModel(policies, "globex", new Map()).limits;
}

it("shows the setting Save sessions to Solus Cloud only when a policy sets it", () => {
  // WHY: when the setting is off, the conversations of the organization's sessions stay on
  // their hosts. A person must see that on the phone, and which policy says so. An explicit
  // On is a rule too: it shows, because the person cannot change it.
  expect(limitsOf({ sessionCloudSync: false })).toEqual([
    { label: "Save sessions to Solus Cloud", value: "Off", source: "Globex" },
  ]);
  expect(limitsOf({ sessionCloudSync: true })).toEqual([
    { label: "Save sessions to Solus Cloud", value: "On", source: "Globex" },
  ]);
  // A policy that does not set it shows no row for it.
  expect(limitsOf({ webhooks: { allowUnverified: false } }).map((row) => row.label)).toEqual(["Unverified webhooks"]);
});
