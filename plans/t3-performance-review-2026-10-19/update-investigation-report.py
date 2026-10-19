import json,re,collections
from pathlib import Path
p=Path(__file__).parent
ledger=json.loads((p/'review-ledger.json').read_text())
rows=[]
for group in ['compiler','platform','stores','ux']:
 rows+=json.loads((p/f'investigation-{group}.json').read_text())
rows.sort(key=lambda r:r['number'])
assert len(rows)==32 and len({r['number'] for r in rows})==32
assert {r['number'] for r in rows}=={r['number'] for r in ledger if r.get('initial_verdict',r['verdict'])=='investigate'}
by={r['number']:r for r in rows}
labels={'ready':'Ready','covered':'Covered','reject':'No separate change','defer':'Deferred','decision':'Decision'}
verdicts={'ready':'relevant','covered':'covered','reject':'not-applicable','defer':'deferred','decision':'decision'}
for item in ledger:
 if item['number'] not in by: continue
 r=by[item['number']]
 if 'initial_verdict' not in item:
  item['initial_verdict']=item['verdict']
  item['initial_assessment']={k:item[k] for k in ['reason','evidence','confidence']}
 item['verdict']=verdicts[r['disposition']]
 item['reason']=r['finding']
 item['evidence']=r['evidence']
 item['confidence']=r['confidence']
 item['investigation']={'date':'2026-10-19',**r}
(p/'investigation-results.json').write_text(json.dumps(rows,indent=2)+'\n')
(p/'review-ledger.json').write_text(json.dumps(ledger,indent=2)+'\n')
def link(n): return f'[#{n}](https://github.com/pingdotgg/t3code/pull/{n})'
def evlink(ev):
 label=ev.rsplit('/',1)[-1]
 return f'[{label}](/Users/sidhu/solus/{ev})'
def clean(value): return str(value).replace('|','\\|').replace('\n',' ')
summary='''## Investigation follow-up — completed 19 October 2026

**All 32 open source investigations now have a disposition.** The result is **16 ready references, three covered, four with no separate change to take, three deferred, and six decisions**. The 16 ready references form **six work areas**, not 16 independent optimizations. The original 446-PR inventory remains intact below. Each of the 32 appendix rows and the review ledger now carries the follow-up result.

“Ready” means there is enough local evidence to plan a focused change. It does not mean the change is implemented, a native speed gain is measured, or device verification is complete. No product source, app configuration, dependency, or live data was changed. Analysis scripts and fixtures are kept with this report.

### Confirmed work and order

| Work area | What the investigation established | Implementation boundary and proof still required |
| --- | --- | --- |
| Native compiler, including one correctness prerequisite | The current Expo configuration enables no React compilation. Across 117 selected files, an enabled probe compiled 232 functions and skipped 31 distinct functions, with 76 diagnostics. A direct call to the installed Expo Metro Babel transformer confirmed activation using the real local Babel config. GuideNoticeCard returns before useState on its ready branch; this violates hook order. | Fix the guide hook order first. Add a function-level compiler baseline, then migrate only diagnosed functions in small stages. Keep existing manual caches until the owning function compiles and its lifetime is checked. Native render, typing, scroll and failure-state measurements remain required. |
| Equal host facts | An equal refresh publishes a new ready wrapper and notifies readers of the same fact key. A recovered connection already avoids repeat reads; a fresh session correctly reloads but publishes equal data again. | Group #20392 and #20855. Retain equal bounded values at HostFacts.write, while keeping freshness, error/loading states, access revocation and generation guards. Check desktop, web and native consumers. |
| Native project snapshots | One equal ThreadDirectory reload replaces the projects array twice and the equal project wrapper once. Project-only subscribers receive a changed snapshot. | Preserve unchanged project values, wrappers and sorted arrays. Keep host-state and session changes observable. Cover rename, add/remove, repository change, host relabel and stale responses. |
| Native PR snapshots and selectors | A real PullRequestDirectory equal list refresh emits three notifications and replaces equal PR DTOs. usePullRequestList rebuilds hosts and row wrappers from a directory-wide revision. | Data sharing alone is insufficient. Preserve equal PR data and separate content snapshots from load state. Keep loading, errors, progressive answers, permissions and check updates. Verify row render counts on native. |
| Project-relative file mutations | Synthetic create and delete operations followed an intermediate symlink to a sibling fixture folder. Lexical containment does not enforce the function's stated project boundary. | Add resolved-parent containment with explicit final-symlink behavior. Keep intentional general file saves outside the project unchanged. This is a mutation-boundary defect, not a proved authorization bypass. |
| Codex late-child delivery | A failed root already exits immediately, so T3's blocked-queue symptom is absent. Root cleanup removes child routing; a later native-child completion is dropped. The retained normalizer can parse that same completion. | Keep a bounded owner for live children separate from the active root run. Do not hold the failed root or its queue open. Test failed/successful roots, a new root turn, stop, reconnect, shutdown and duplicate-report prevention. |

The first compiler change should be the coverage check and the hook-order correction. The host, project and PR store changes can then be measured independently. Keep file containment and Codex child ownership as separate correctness changes. The previously identified native list-size and Android fixes remain separate candidates; this follow-up does not claim to have reproduced them on a device.

### What the probes proved

The store run passed **33 tests**: five new characterization probes and 28 existing tests. The server/connection baseline passed **78 existing tests**, and the platform run passed **five synthetic probes**. Total: **116 passing tests and probes, zero failures in those final runs**. Four additional isolated Git discovery checks passed. Characterization probes assert current behavior, including confirmed defects; they are evidence, not regression tests for a fix.

The broad compiler check used the installed Babel/Expo preset with a reconstructed Metro caller: **234 serial transforms over 117 selected files**, with no transform crashes. It used Babel 7.29.0, Expo preset 58.0.12 and React Compiler 1.0.0. A separate smoke check called the **installed Expo Metro Babel transformer with the actual local Babel configuration** on SourceFileSurface: compiler off produced zero memo-cache calls; compiler on produced two. Neither check started Metro, bundled the app or ran a native build. Compilation does not measure user-visible performance.

In-memory source experiments showed that narrow changes can make ComposerEditor, FileMarkdownPreview, the PR action hook, StatusFadeIn and the guide notice compile. Larger composer, feed and sidebar experiments exposed additional diagnostics after the first blocker was removed. The report therefore does not prescribe deleting all manual memoization. Keep synchronous-throw and rejected-promise cleanup when changing try/finally. Some ref diagnostics are compiler alias-analysis limits, not proof of an existing React runtime defect.

PR-link parsing took a median **0.112 ms per 100 links** in nine warmed host-only samples (range 0.109–0.125 ms). This is a synthetic Bun microbenchmark, not a Svelte or phone profile. It does not justify a new cache now. Mutation checks also show why a WeakMap keyed only by a mutable link can return stale results.

### Closed leads, deferrals and choices

- **Covered:** #20149 already has the iPad drawer background; #20445's paired route is not replaced by a newly discovered HTTP address; #20835's Claude query retains background-task lifetime and emits a late nested launch with its parent ID. The Claude proof covers the adapter, not every provider timing or UI projection.
- **No separate change:** #20379, #20396 and #20397 are React web compiler ports; their useful native lessons are included in the measured mobile project. #21260 finds no current local hookless-use target: a syntax scan checked 484 native source files and 87 use-prefixed definitions, with zero candidates.
- **Deferred:** #21147 PR-link caching has no measured material cost. #20813's combined Android navigation redesign conflicts with the current two-tab plan; investigate bounded retention only if measured tab returns are slow. #20384's fingerprint defect is reproduced, but the inspected Solus release setup does not use fingerprint-based OTA compatibility. It must be fixed before such a release policy is adopted.
- **Optional UI choices:** #20327 native iOS segmented controls, #20812 compact-until-wrap composer, #21250 native Share, and #21319 close/apply icons. Recommended default: leave these unchanged in the first performance batch. Each has a concrete implementation boundary and device checklist in the investigation register. Current Copy link is already present. A settings X must not promise to undo options that apply immediately.
- **Git policy decision (#20440):** implicit bare discovery is confirmed; an option-injection or command-execution defect was not proved. An explicit-only policy needs a decision about supported bare workflows, followed by compatibility tests.
- **Snapshot contract decision (#20446):** masked input values survive in raw snapshot RPC data, but the ordinary agent text omits element.value and the RPC is owner-gated. This is a data-minimization gap, not evidence of an ordinary password leak into provider text. Recommended small follow-up: omit password/CSS-masked values at extraction. A stronger guarantee for secrets reflected into labels or frames is separate work.

The six decisions do not block the confirmed performance work. No optional redesign is assumed approved by this report.

### Remaining verification before release

No real browser, provider, simulator or physical device was used. No app build or dev server was started. Native iOS and Android still need measurements for render counts, long-list stability, keyboard/IME behavior, focus, navigation and memory. Shared store changes need desktop, web and native checks over IPC and WebSockets. The compiler smoke used an iOS caller; Android transform and native runtime checks remain release gates. Source and synthetic event proofs do not replace these checks.

The baseline is the current working tree at commit `14eec2300a7619ffa21a42b2bf126de38dbd4d47`, including existing uncommitted work. Installed package versions, source lines and upstream status can change. This follow-up examined the 32 open investigations; it did not re-review all 446 patches or all dependency binaries.

### Reproduce the evidence

Run from `/Users/sidhu/solus`. The retained scripts use synthetic data and write evidence only inside this report folder; the existing test preload isolates test runtime data. The scripts describe current behavior and may need revision after implementation.

```sh
bun test plans/t3-performance-review-2026-10-19/store-investigation.test.ts tests/unit/host-facts.test.ts tests/unit/native-mobile-prs-progressive.test.ts tests/unit/linked-pr-store.test.ts
bun test plans/t3-performance-review-2026-10-19/investigation-platform-probes.test.ts plans/t3-performance-review-2026-10-19/investigation-claude-late-child.test.ts
node plans/t3-performance-review-2026-10-19/probe-mobile-compiler.cjs --manifest plans/t3-performance-review-2026-10-19/compiler-probe-files.json
node plans/t3-performance-review-2026-10-19/probe-expo-transformer.cjs
python3 plans/t3-performance-review-2026-10-19/investigation-git-safety.py
```

[Compiler evidence](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/compiler-probe-results.json), [actual Expo transformer smoke](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/expo-transformer-probe-results.json), [store results](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/store-probe-output.txt), [platform baseline](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/investigation-existing-tests.log), and [platform probes](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/investigation-platform-probes.log) support the results above. The [complete investigation register](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/investigation-results.json) includes proof, next steps, effort, risk and confidence for every item.

### Investigation register — all 32 items

| PR | Result | Finding | Local evidence |
| --- | --- | --- | --- |
'''
for r in rows:
 refs='<br>'.join(evlink(e) for e in r['evidence'][:3])
 summary+=f"| {link(r['number'])} | {labels[r['disposition']]} | {clean(r['finding'])} | {refs} |\n"
summary+='\n'
(p/'investigation-summary.md').write_text(summary)
report=(p/'report.md').read_text()
if '## Investigation follow-up' in report:
 start=report.index('## Investigation follow-up')
 end=report.index('## What to take from this work',start)
 report=report[:start]+report[end:]
report=report.replace('## What to take from this work',summary+'## What to take from this work',1)
report=report.replace('Across all 446 PRs, the result is **11 direct candidates, 32 targeted investigations, 23 covered, and 380 with no direct Solus change identified**.', 'The initial source review found **11 direct candidates, 32 targeted investigations, 23 covered, and 380 with no direct Solus change identified**. The follow-up above resolves all 32 investigation labels; use its decisions and the current totals below.')
report=report.replace('The appendix gives every PR its own decision.', 'The appendix gives every PR its own current decision. “Ready after investigation,” “Deferred,” and “Decision” refer to the follow-up above; original assessments remain in the ledger.')
report=report.replace('This was a source review. No Solus benchmark, native device run, browser session, or implementation was performed.', 'The initial pass was a source review. The follow-up above adds isolated tests, transform checks and a host microbenchmark. No native device run, real browser session or product implementation was performed.')
# Preserve initial narrative as historical where exact wording differs.
report=report.replace('### 4. Measure equal refreshes before adding more caching','### 4. Equal refreshes — confirmed by the follow-up')
report=report.replace('**Priority:** targeted investigation. **Effort:** S to measure, M if a gap is confirmed. **Change risk:** medium. **Confidence:** medium.', '**Priority:** confirmed work; see the follow-up for the measured boundary. **Effort:** M. **Change risk:** medium. **Confidence:** high for extra identity changes; render savings remain unmeasured.')
report=report.replace('Measure identical refreshes and reconnects at these boundaries.', 'The follow-up measured equal host, native project and native PR refreshes and confirmed extra identity changes. Svelte PullRequest.apply was not included in those probes.')
report=report.replace('### 5. Profile repeated PR-link parsing and clock-driven updates','### 5. Defer PR-link caching; keep clock work separate')
report=report.replace('This is a useful measurement target for sessions with large PR stacks.', 'The follow-up host probe found about 0.112 ms per 100 links, so caching is deferred unless a renderer profile shows material cost.')
report=report.replace('Only pursue the cache and clock items when measurements show a useful saving.', 'The follow-up confirms three store work areas. Keep their render measurements as acceptance checks; PR-link caching remains deferred. Clock work remains a separate candidate.')
report=report.replace('These are suggested checks, not results from this review.', 'These were suggested checks in the first pass. The follow-up above records the tests actually run; unlisted checks remain unrun.')
# Clarify the old source-only limitations without silently erasing them.
for line in report.splitlines():
 if line.startswith('This was a source review.'):
  report=report.replace(line,'The initial pass was a source review. The follow-up above adds isolated tests, transform checks and a host microbenchmark. No native device run, real browser session, app build or product implementation was performed.')
# Replace investigation table rows with the current finding.
lines=report.splitlines()
lookup={r['number']:r for r in ledger}
for i,line in enumerate(lines):
 match=re.match(r'^\| \[(\d+)\]\(https://github.com/pingdotgg/t3code/pull/',line)
 if not match or int(match[1]) not in by: continue
 n=int(match[1]); r=by[n]; old=lookup[n]; cols=line.split(' | ')
 state=cols[1].split(' · ')[-1]
 label='Ready after investigation' if r['disposition']=='ready' else labels[r['disposition']]
 refs='<br>'.join(evlink(e) for e in r['evidence'][:4])
 lines[i]=f"| [{n}]({old['url']}) — {clean(old['title'])} | {label} · {state} | {clean(old['mechanism'])} Follow-up: {clean(r['finding'])} | {refs} |"
report='\n'.join(lines)+'\n'
# Retain original totals as an explicitly historical comparison and add current totals.
current=collections.Counter(r['verdict'] for r in ledger)
newtot='## Review totals after investigation\n\n| Current decision | PRs |\n| --- | ---: |\n'
for k,label in [('relevant','Relevant, including 16 ready references'),('covered','Covered'),('not-applicable','No direct or separate change'),('deferred','Deferred'),('decision','Product or hardening decision')]:
 newtot+=f'| {label} | {current[k]} |\n'
newtot+='| **Total** | **446** |\n\nThe 27 relevant PR references overlap. They are not 27 independent tasks. The 16 new ready references form the six work areas above.\n\n### Initial review totals, before the 32 investigations\n'
report=report.replace('## Review totals\n',newtot,1)
(p/'report.md').write_text(report)
assert len(re.findall(r'^\| \[\d+\]\(https://github.com/pingdotgg/t3code/pull/',report,re.M))==446
assert len(ledger)==446 and len({r['number'] for r in ledger})==446
assert sum(r['verdict']=='investigate' for r in ledger)==0
print(json.dumps({'investigations':len(rows),'outcomes':dict(collections.Counter(r['disposition'] for r in rows)),'currentTotals':dict(current),'reportCharacters':len(report),'prAppendixRows':446},indent=2))
