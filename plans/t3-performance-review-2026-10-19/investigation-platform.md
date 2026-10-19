# Six platform investigations

Two changes are ready for implementation planning, two upstream leads are already covered in the inspected paths, and two need a product/security policy decision. None is a measured performance improvement.

### [CORRECTNESS-01] Keep project-relative mutations inside the resolved project

- **Evidence:** `packages/server/src/transport/handlers/filesystem-handlers.ts:231` resolves the project root, then sends the child path to `applyProjectFileMutation`. `packages/server/src/files/project-mutations.ts:41` checks lexical containment only; create and delete then follow intermediate directory symlinks. The function's comment at line 20 promises containment.
- **Impact:** A project-tree action on `linked-folder/file` can create or delete a file in the directory that the link points to outside the project. The synthetic fixture proves both operations. This is an unintended destination problem, not privilege escalation: `packages/contracts/src/permissions.ts:167` grants host-wide file writes, and general `writeFile` intentionally saves outside the project.
- **Effort:** M, including create/rename/delete and symlink tests.
- **Risk:** MED. Legitimate linked folders must have an explicit rule. Deleting a final symlink itself should remain possible without deleting its target.
- **Confidence:** HIGH. Source path and harmless deterministic fixture agree.
- **Fix sketch:** Check resolved existing parent paths for project-relative mutations, including destinations not yet created. Keep host-destination and general editor saves on their current separate authority path. Do not import T3's registered-project-only policy.

### [CORRECTNESS-02] Keep live Codex children routable after the root settles

- **Evidence:** `codex-backend.ts:1499` clears all routing before `finishRun`; `:1607` removes every child mapping for the session. A late child frame then cannot resolve a session at `:1574` and returns at `:1179`. The normalizer is owned by the removed active root handle.
- **Impact:** A native child that finishes after its root succeeds or fails loses live progress/completion delivery. A fixture proves the failed root exits immediately, then the child's completion is dropped even though the retained normalizer can parse it. T3's stuck-running/blocked-queue defect is absent; the confirmed local defect is late-child event loss.
- **Effort:** M–L, including lifetime, overlap and cleanup tests.
- **Risk:** HIGH. A new root turn can overlap old children, and Stop/reconnect/shutdown must release the right owner without duplicate reports.
- **Confidence:** HIGH for the adapter loss; no authenticated provider run was used.
- **Fix sketch:** Retain a bounded owner and normalizer for live native descendants independently of the active root run. End the root immediately and let its queue proceed. Release each retained owner when its known children settle or stop, and cover success, failure, new turns and shutdown.

## Covered or decision items

**#20445 — covered for the upstream behaviors.** A paired host never borrows a newly discovered plain-HTTP route (`uplink-session.ts:247`); the existing test and a synthetic HTTPS-paired case prove this. SSH bootstrap is an explicit connection step that saves a token, not the reconnect broker used in T3. Explicit HTTP connections remain allowed by design. The identity probe runs beside ticket exchange, so it is not a guarantee that credentials wait for identity verification. Changing that broader trust model is separate work.

**#20835 — covered at the adapter boundary.** The Claude query remains open while background IDs exist. A synthetic root-result → nested Agent launch emits the nested event immediately under its original parent without waiting for another root turn. Later progress retains the nested parent. This does not prove every live provider timing or UI projection; it resolves the alleged adapter buffer failure.

**#20440 — decision, not a confirmed exploit.** A harmless isolated Git fixture proves implicit bare discovery accepts local config and `safe.bareRepository=explicit` rejects that discovery while explicit `--git-dir` still works. No hook executes. The central wrapper lacks the guard, but the inspected revision callers use captured/provider commit identities, and the checkout RPC checks listed branches. Decide whether implicit bare use should be prohibited before changing all Git subprocesses and hook behavior.

**#20446 — decision, with a narrower boundary.** Raw `BrowserSnapshot.elements[].value` contains synthetic password and CSS-masked field values. Agent text omits those values. The raw RPC is owner-only, and the mapped first-party client regions have no direct caller. Labels are serialized independently without secret redaction, so a page that itself echoes a masked value in an accessibility label could expose that label. Prefer a small contract decision to omit masked values before considering T3's larger cross-frame redaction protocol. Standalone pairing already prints to stdout; the OpenCode setting is absent. There is no demonstrated ordinary-password-to-provider leak.

## Proof and limits

- `investigation-existing-tests.log`: 78 existing tests pass across the route registry, project mutations, Codex routing/completion/background commands and Claude steering/normalizer suites.
- `investigation-platform-probes.log`: 5 synthetic tests pass across two files, with 25 assertions. Browser work uses a fake driver and a VM DOM fixture. No browser starts. Claude/Codex use synthetic event sequences and no provider credentials.
- `investigation-git-safety.json`: four harmless isolated Git discovery checks pass. The helper disables user/system Git config and cleans its fixture directory. An initial in-process Git probe was unsuitable and was replaced with this isolated subprocess proof; it did not establish a product failure.
- `investigation-platform.json`: exactly six numbered results, with specific source references, commands, next steps, effort, risk and confidence.

No source file, original review ledger or report was edited. No build, installation, dev server, live data mutation, real browser or authenticated provider run occurred. All test fixtures used synthetic content and were removed. Source references describe the current working files and can move as other work continues.
