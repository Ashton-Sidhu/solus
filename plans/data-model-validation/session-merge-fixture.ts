// Fixture: current 4-table session schema vs one merged `session` row.
// Runs the real statements (session-records.ts, session-states.ts, lead-sessions.ts,
// session-admissions.ts) and their merged rewrites against the same data, compares
// results, EXPLAIN QUERY PLAN, and timings. bun:sqlite only; no repo files touched.
import { Database } from 'bun:sqlite'

const N = 5000
const NOW = 1_762_000_000_000
const IDLE_MS = 14 * 24 * 3600_000 // SESSION_LIST_IDLE_MS stand-in
const READER = 'acct:bob'
const OPEN_PR = `session_pull_requests.source <> 'dismissed' AND (session_pull_requests.pr_state IS NULL OR session_pull_requests.pr_state NOT IN ('merged', 'closed', 'missing'))`

function current(): Database {
  const db = new Database(':memory:')
  db.exec(`
  CREATE TABLE session_records (session_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL DEFAULT 'local', publication TEXT NOT NULL DEFAULT 'local',
    owner_key TEXT NOT NULL, provider TEXT NOT NULL, project_path TEXT NOT NULL, project_remote TEXT, runner_host_id TEXT, title TEXT, custom_title TEXT,
    status TEXT NOT NULL DEFAULT 'idle', model TEXT, reasoning_effort TEXT, parent_session_id TEXT, root_session_id TEXT, created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0, cwd TEXT, slug TEXT, is_worktree INTEGER NOT NULL DEFAULT 0, branch TEXT, project_root TEXT,
    delegation_message_id TEXT, delegation_depth INTEGER, delegation_intent TEXT, delegation_created_at INTEGER, place TEXT, started_by TEXT);
  CREATE INDEX sessions_api_page ON session_records(organization_id, created_at DESC, session_id DESC);
  CREATE INDEX sessions_api_provider_page ON session_records(organization_id, provider, created_at DESC, session_id DESC);
  CREATE INDEX sessions_api_activity_page ON session_records(organization_id, last_activity_at DESC, session_id DESC);
  CREATE INDEX session_records_by_activity ON session_records(last_activity_at);
  CREATE INDEX session_records_by_place ON session_records(place, last_activity_at);
  CREATE TABLE session_admissions (organization_id TEXT NOT NULL, admission_id TEXT NOT NULL, host_id TEXT NOT NULL, owner_key TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(organization_id, admission_id));
  CREATE TABLE session_states (session_id TEXT PRIMARY KEY, settled_at INTEGER, settled_by TEXT, unsettled_at INTEGER, last_prompt_at INTEGER, viewed_at INTEGER, execution_preferences TEXT, organization_id TEXT NOT NULL DEFAULT 'local');
  CREATE INDEX session_states_settled ON session_states(settled_at);
  CREATE TABLE session_leads (session_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, organization_id TEXT NOT NULL DEFAULT 'local');
  ${shared()}`)
  return db
}

function merged(): Database {
  const db = new Database(':memory:')
  db.exec(`
  CREATE TABLE session (
    session_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL DEFAULT 'local',
    owner_key TEXT NOT NULL,
    publication TEXT NOT NULL DEFAULT 'local',
    -- admission (null on a personal machine): who accepted the session and for which host
    admitted_host_id TEXT, admitted_at INTEGER,
    -- provider facts: null until the provider starts (started_at IS NULL == "no record yet")
    started_at INTEGER, provider TEXT, project_path TEXT, project_remote TEXT, runner_host_id TEXT, title TEXT, custom_title TEXT,
    status TEXT NOT NULL DEFAULT 'idle', model TEXT, reasoning_effort TEXT, parent_session_id TEXT, root_session_id TEXT,
    created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, cwd TEXT, slug TEXT,
    is_worktree INTEGER NOT NULL DEFAULT 0, branch TEXT, project_root TEXT,
    delegation_message_id TEXT, delegation_depth INTEGER, delegation_intent TEXT, delegation_created_at INTEGER, place TEXT, started_by TEXT,
    -- shared shelf state (was session_states)
    settled_at INTEGER, settled_by TEXT, unsettled_at INTEGER, last_prompt_at INTEGER, viewed_at INTEGER, execution_preferences TEXT,
    -- lead (was session_leads)
    lead_started_at INTEGER,
    CHECK (started_at IS NULL OR (provider IS NOT NULL AND project_path IS NOT NULL)),
    CHECK ((settled_at IS NULL) = (settled_by IS NULL))
  );
  CREATE INDEX session_api_page ON session(organization_id, created_at DESC, session_id DESC);
  CREATE INDEX session_api_provider_page ON session(organization_id, provider, created_at DESC, session_id DESC);
  CREATE INDEX session_api_activity_page ON session(organization_id, last_activity_at DESC, session_id DESC);
  CREATE INDEX session_by_activity ON session(last_activity_at);
  CREATE INDEX session_by_place ON session(place, last_activity_at);
  ${shared()}`)
  return db
}

function shared(): string {
  return `
  CREATE TABLE session_views (session_id TEXT NOT NULL, person_key TEXT NOT NULL, settled_at INTEGER, archived_at INTEGER, snoozed_until INTEGER, snooze_note TEXT, organization_id TEXT NOT NULL DEFAULT 'local', PRIMARY KEY(session_id, person_key));
  CREATE INDEX session_views_by_person ON session_views(person_key, session_id);
  CREATE INDEX session_views_snoozed ON session_views(person_key, session_id) WHERE snoozed_until IS NOT NULL;
  CREATE TABLE session_pull_requests (session_id TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, created_by TEXT NOT NULL, linked_at INTEGER NOT NULL, pr_state TEXT, pr_draft INTEGER, pr_updated_at TEXT, organization_id TEXT NOT NULL DEFAULT 'local', PRIMARY KEY(session_id, repository, number));
  CREATE INDEX session_pull_requests_by_pull_request ON session_pull_requests(repository, number);
  CREATE INDEX session_pull_requests_open ON session_pull_requests(session_id) WHERE source <> 'dismissed' AND (pr_state IS NULL OR pr_state NOT IN ('merged', 'closed', 'missing'));
  CREATE TABLE acl_entry (resource_kind TEXT, resource_id TEXT, subject_kind TEXT, subject_id TEXT, granted_by_user_id TEXT, granted_at INTEGER, created_at INTEGER, expires_at INTEGER);
  CREATE INDEX acl_entry_by_subject ON acl_entry(subject_kind, subject_id, resource_kind, resource_id);
  CREATE INDEX acl_entry_by_resource ON acl_entry(resource_kind, resource_id);`
}

// Deterministic PRNG so both schemas get identical data.
let seed = 42
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!

interface Row { id: string; org: string; owner: string; provider: string; created: number; activity: number; status: string; remote: string | null; branch: string | null; place: string;
  state: null | { settled_at: number | null; settled_by: string | null; unsettled_at: number | null; last_prompt_at: number | null; viewed_at: number | null }
  lead: number | null; admitted: null | { host: string; at: number }; view: null | { archived_at: number | null; snoozed_until: number | null }; prs: Array<{ n: number; state: string | null; updated: string | null; source: string }>; acl: boolean }

function generate(): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < N; i++) {
    const org = rnd() < 0.5 ? 'local' : pick(['org_a', 'org_b'])
    const created = NOW - Math.floor(rnd() * 120 * 24 * 3600_000)
    const activity = created + Math.floor(rnd() * (NOW - created))
    const owner = rnd() < 0.6 ? READER : pick(['acct:alice', 'acct:carol', 'host:mac'])
    const hasState = rnd() < 0.4
    const settled = hasState && rnd() < 0.4
    rows.push({
      id: `s${String(i).padStart(5, '0')}`, org, owner, provider: pick(['claude-code', 'codex']), created, activity,
      status: pick(['idle', 'idle', 'idle', 'running']), remote: rnd() < 0.5 ? pick(['github.com/solus/solus', 'github.com/solus/site']) : null,
      branch: rnd() < 0.6 ? `feat/${i}` : null, place: pick(['project', 'project', 'chat']),
      state: hasState ? { settled_at: settled ? activity + 1000 : null, settled_by: settled ? pick(['pull-request', 'task', 'idle']) : null,
        unsettled_at: rnd() < 0.2 ? activity - 5000 : null, last_prompt_at: rnd() < 0.8 ? activity - 60_000 : null, viewed_at: rnd() < 0.5 ? activity : null } : null,
      lead: rnd() < 0.03 ? created : null,
      admitted: org !== 'local' && rnd() < 0.5 ? { host: 'vm-1', at: created - 500 } : null,
      view: rnd() < 0.2 ? { archived_at: rnd() < 0.3 ? activity + 10 : null, snoozed_until: rnd() < 0.3 ? NOW + 3600_000 : null } : null,
      prs: rnd() < 0.3 ? [{ n: i, state: pick([null, 'open', 'merged', 'closed']), updated: rnd() < 0.8 ? new Date(activity + Math.floor(rnd() * 200_000) - 100_000).toISOString() : null, source: rnd() < 0.1 ? 'dismissed' : 'branch' }] : [],
      acl: rnd() < 0.05,
    })
  }
  return rows
}

function loadShared(db: Database, rows: Row[]) {
  const view = db.prepare(`INSERT INTO session_views(session_id, person_key, archived_at, snoozed_until, organization_id) VALUES (?, ?, ?, ?, ?)`)
  const pr = db.prepare(`INSERT INTO session_pull_requests(session_id, repository, number, url, title, source, created_by, linked_at, pr_state, pr_updated_at, organization_id) VALUES (?, 'github.com/solus/solus', ?, 'u', 't', ?, 'x', ?, ?, ?, ?)`)
  const acl = db.prepare(`INSERT INTO acl_entry VALUES ('session', ?, 'user', ?, 'acct:alice', ?, ?, NULL)`)
  for (const r of rows) {
    if (r.view) view.run(r.id, READER, r.view.archived_at, r.view.snoozed_until, r.org)
    for (const p of r.prs) pr.run(r.id, p.n, p.source, r.created, p.state, p.updated, r.org)
    if (r.acl) acl.run(r.id, READER, r.activity, r.activity)
  }
}

function loadCurrent(db: Database, rows: Row[]) {
  const rec = db.prepare(`INSERT INTO session_records(session_id, organization_id, publication, owner_key, provider, project_path, project_remote, status, created_at, last_activity_at, branch, place) VALUES (?, ?, ?, ?, ?, '-repo', ?, ?, ?, ?, ?, ?)`)
  const st = db.prepare(`INSERT INTO session_states(session_id, settled_at, settled_by, unsettled_at, last_prompt_at, viewed_at, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  const lead = db.prepare(`INSERT INTO session_leads VALUES (?, ?, ?)`)
  const adm = db.prepare(`INSERT INTO session_admissions VALUES (?, ?, ?, ?, ?)`)
  db.transaction(() => {
    for (const r of rows) {
      rec.run(r.id, r.org, r.org === 'local' ? 'local' : 'published', r.owner, r.provider, r.remote, r.status, r.created, r.activity, r.branch, r.place)
      if (r.state) st.run(r.id, r.state.settled_at, r.state.settled_by, r.state.unsettled_at, r.state.last_prompt_at, r.state.viewed_at, r.org)
      if (r.lead) lead.run(r.id, r.lead, r.org)
      if (r.admitted) adm.run(r.org, r.id, r.admitted.host, r.owner, r.admitted.at)
    }
    loadShared(db, rows)
  })()
}

function loadMerged(db: Database, rows: Row[]) {
  const ins = db.prepare(`INSERT INTO session(session_id, organization_id, publication, owner_key, admitted_host_id, admitted_at, started_at, provider, project_path, project_remote, status, created_at, last_activity_at, branch, place,
    settled_at, settled_by, unsettled_at, last_prompt_at, viewed_at, lead_started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '-repo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  db.transaction(() => {
    for (const r of rows) ins.run(r.id, r.org, r.org === 'local' ? 'local' : 'published', r.owner, r.admitted?.host ?? null, r.admitted?.at ?? null, r.created, r.provider, r.remote, r.status, r.created, r.activity, r.branch, r.place,
      r.state?.settled_at ?? null, r.state?.settled_by ?? null, r.state?.unsettled_at ?? null, r.state?.last_prompt_at ?? null, r.state?.viewed_at ?? null, r.lead)
    loadShared(db, rows)
  })()
}

// ---- Queries: current (left) and merged (right). `T` is the record table name. ----
const directShare = (col: string, T: string) => `(SELECT ${col} FROM acl_entry AS acl WHERE acl.resource_kind = 'session' AND acl.resource_id = ${T}.session_id AND ((acl.subject_kind = 'user' AND acl.subject_id = $reader)) AND (acl.expires_at IS NULL OR acl.expires_at > $now) ORDER BY COALESCE(acl.granted_at, acl.created_at) DESC LIMIT 1)`
function listedClause(T: string) {
  const grantedAt = directShare('COALESCE(acl.granted_at, acl.created_at)', T)
  const active = `(${T}.last_activity_at >= $since OR session_views.snoozed_until IS NOT NULL OR EXISTS (SELECT 1 FROM session_pull_requests WHERE session_pull_requests.session_id = ${T}.session_id AND ${OPEN_PR}))`
  return `((session_views.archived_at IS NULL AND (${T}.owner_key = $reader OR session_views.person_key IS NOT NULL) AND ${active}) OR (${grantedAt} > COALESCE(session_views.archived_at, -1) AND (${active} OR ${grantedAt} >= $since)))`
}
function candidates(T: string, where: string) {
  return `SELECT session_id FROM ${T} WHERE last_activity_at >= $since AND ${where}
  UNION SELECT session_id FROM session_views WHERE person_key = $reader AND snoozed_until IS NOT NULL
  UNION SELECT session_id FROM session_pull_requests WHERE ${OPEN_PR}
  UNION SELECT resource_id FROM acl_entry WHERE resource_kind = 'session' AND ((subject_kind = 'user' AND subject_id = $reader))`
}
const RECORD_COLS = ['session_id', 'organization_id', 'publication', 'owner_key', 'provider', 'project_path', 'project_remote', 'runner_host_id', 'title', 'custom_title', 'status', 'model', 'reasoning_effort', 'parent_session_id', 'root_session_id', 'created_at', 'last_activity_at', 'size', 'cwd', 'slug', 'is_worktree', 'branch', 'project_root', 'delegation_message_id', 'delegation_depth', 'delegation_intent', 'delegation_created_at', 'place', 'started_by']
const VIEW_COLS = 'session_views.settled_at AS view_settled_at, session_views.archived_at, session_views.snoozed_until, session_views.snooze_note'

function listPageCurrent(where: string, time: string) {
  const T = 'session_records'
  const ids = `SELECT session_records.session_id FROM (${candidates(T, where)}) AS list_candidates CROSS JOIN session_records
    LEFT JOIN session_views ON session_views.session_id = session_records.session_id AND session_views.person_key = $reader
    WHERE session_records.session_id = list_candidates.session_id AND ${where} AND ${listedClause(T)}
    ORDER BY session_records.${time} DESC, session_records.session_id DESC LIMIT $limit`
  return `SELECT ${RECORD_COLS.map((c) => `session_records.${c}`).join(', ')},
      EXISTS(SELECT 1 FROM session_leads WHERE session_leads.session_id = session_records.session_id) AS is_lead,
      session_states.settled_at, session_states.settled_by, ${VIEW_COLS},
      ${directShare('acl.granted_by_user_id', T)} AS shared_by, ${directShare('COALESCE(acl.granted_at, acl.created_at)', T)} AS granted_at, 1 AS listed
    FROM (${ids}) AS list_page CROSS JOIN session_records
    LEFT JOIN session_states ON session_states.session_id = session_records.session_id
    LEFT JOIN session_views ON session_views.session_id = session_records.session_id AND session_views.person_key = $reader
    WHERE session_records.session_id = list_page.session_id ORDER BY session_records.${time} DESC, session_records.session_id DESC LIMIT $limit`
}
function listPageMerged(where: string, time: string) {
  const T = 'session'
  const ids = `SELECT session.session_id FROM (${candidates(T, where)}) AS list_candidates CROSS JOIN session
    LEFT JOIN session_views ON session_views.session_id = session.session_id AND session_views.person_key = $reader
    WHERE session.session_id = list_candidates.session_id AND ${where} AND ${listedClause(T)}
    ORDER BY session.${time} DESC, session.session_id DESC LIMIT $limit`
  return `SELECT ${RECORD_COLS.map((c) => `session.${c}`).join(', ')},
      (session.lead_started_at IS NOT NULL) AS is_lead,
      session.settled_at, session.settled_by, ${VIEW_COLS},
      ${directShare('acl.granted_by_user_id', T)} AS shared_by, ${directShare('COALESCE(acl.granted_at, acl.created_at)', T)} AS granted_at, 1 AS listed
    FROM (${ids}) AS list_page CROSS JOIN session
    LEFT JOIN session_views ON session_views.session_id = session.session_id AND session_views.person_key = $reader
    WHERE session.session_id = list_page.session_id ORDER BY session.${time} DESC, session.session_id DESC LIMIT $limit`
}

const Q = {
  listPage: {
    cur: listPageCurrent(`session_records.parent_session_id IS NULL AND session_records.started_by IS NULL`, 'last_activity_at'),
    mrg: listPageMerged(`session.parent_session_id IS NULL AND session.started_at IS NOT NULL`, 'last_activity_at'),
    params: { $reader: READER, $now: NOW, $since: NOW - IDLE_MS, $limit: 50 },
  },
  settleEndedPRs: {
    cur: `SELECT session_pull_requests.session_id, SUM(CASE WHEN session_pull_requests.pr_state IN ('merged','closed','missing') THEN 0 ELSE 1 END) AS open_links,
      MAX(session_pull_requests.pr_updated_at) AS ended_at, MAX(session_states.unsettled_at) AS unsettled_at, MAX(session_states.last_prompt_at) AS last_prompt_at
      FROM session_pull_requests LEFT JOIN session_states ON session_states.session_id = session_pull_requests.session_id
      WHERE session_pull_requests.source <> 'dismissed' AND session_states.settled_at IS NULL GROUP BY session_pull_requests.session_id`,
    mrg: `SELECT session_pull_requests.session_id, SUM(CASE WHEN session_pull_requests.pr_state IN ('merged','closed','missing') THEN 0 ELSE 1 END) AS open_links,
      MAX(session_pull_requests.pr_updated_at) AS ended_at, MAX(session.unsettled_at) AS unsettled_at, MAX(session.last_prompt_at) AS last_prompt_at
      FROM session_pull_requests JOIN session ON session.session_id = session_pull_requests.session_id
      WHERE session_pull_requests.source <> 'dismissed' AND session.settled_at IS NULL GROUP BY session_pull_requests.session_id`,
    params: {},
  },
  liveBranches: {
    cur: `SELECT session_records.session_id, session_records.project_remote, session_records.branch, session_records.owner_key, session_records.status FROM session_records
      LEFT JOIN session_states ON session_states.session_id = session_records.session_id
      WHERE session_records.organization_id <> 'local' AND session_records.project_remote IS NOT NULL AND session_records.branch IS NOT NULL AND session_records.last_activity_at >= $since AND session_states.settled_at IS NULL`,
    mrg: `SELECT session_id, project_remote, branch, owner_key, status FROM session
      WHERE organization_id <> 'local' AND project_remote IS NOT NULL AND branch IS NOT NULL AND last_activity_at >= $since AND settled_at IS NULL`,
    params: { $since: NOW - IDLE_MS },
  },
  settledIds: {
    cur: `SELECT session_id FROM session_states WHERE settled_at IS NOT NULL AND session_id IN ('s00001','s00002','s00003','s00010','s00100','s01000','s02000','s03000','s04000','s04999')`,
    mrg: `SELECT session_id FROM session WHERE settled_at IS NOT NULL AND session_id IN ('s00001','s00002','s00003','s00010','s00100','s01000','s02000','s03000','s04000','s04999')`,
    params: {},
  },
  isLead: {
    cur: `SELECT session_id FROM session_leads WHERE session_id = $id`,
    mrg: `SELECT session_id FROM session WHERE session_id = $id AND lead_started_at IS NOT NULL`,
    params: { $id: 's00007' },
  },
  admission: {
    cur: `SELECT organization_id, admission_id, host_id, owner_key, created_at FROM session_admissions WHERE organization_id = $org AND admission_id = $id`,
    mrg: `SELECT organization_id, session_id AS admission_id, admitted_host_id AS host_id, owner_key, admitted_at AS created_at FROM session WHERE organization_id = $org AND session_id = $id AND admitted_at IS NOT NULL`,
    params: { $org: 'org_a', $id: 's00005' },
  },
  shelfState: {
    cur: `SELECT session_id, settled_at, settled_by, unsettled_at, last_prompt_at FROM session_states WHERE session_id = $id`,
    mrg: `SELECT session_id, settled_at, settled_by, unsettled_at, last_prompt_at FROM session WHERE session_id = $id`,
    params: { $id: 's00011' },
  },
}

function plan(db: Database, sqlText: string, params: Record<string, unknown>) {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sqlText}`).all(params as never) as Array<{ detail: string }>).map((r) => r.detail)
}
function time(db: Database, sqlText: string, params: Record<string, unknown>, iterations = 200) {
  const stmt = db.prepare(sqlText)
  stmt.all(params as never)
  const t0 = performance.now()
  for (let i = 0; i < iterations; i++) stmt.all(params as never)
  return ((performance.now() - t0) / iterations).toFixed(3)
}
const norm = (rows: unknown[]) => JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r as object).map(([k, v]) => [k, v === 1 && (k === 'is_lead') ? 1 : v === 0 && k === 'is_lead' ? 0 : v]))))

const rows = generate()
const cur = current(); loadCurrent(cur, rows)
const mrg = merged(); loadMerged(mrg, rows)
console.log(`rows: ${N} sessions; states=${rows.filter((r) => r.state).length} leads=${rows.filter((r) => r.lead).length} admissions=${rows.filter((r) => r.admitted).length} views=${rows.filter((r) => r.view).length} prs=${rows.filter((r) => r.prs.length).length}\n`)

for (const [name, q] of Object.entries(Q)) {
  const a = cur.prepare(q.cur).all(q.params as never)
  const b = mrg.prepare(q.mrg).all(q.params as never)
  // settleEndedPRs: a session with no state row today yields the same as a row of nulls, so compare as sets of session ids + fields.
  const same = norm(a) === norm(b)
  console.log(`== ${name}: rows cur=${a.length} mrg=${b.length} parity=${same ? 'OK' : 'DIFF'}  avg ms cur=${time(cur, q.cur, q.params)} mrg=${time(mrg, q.mrg, q.params)}`)
  if (!same) { console.log('  first cur', JSON.stringify(a[0])); console.log('  first mrg', JSON.stringify(b[0])) }
  const pa = plan(cur, q.cur, q.params), pb = plan(mrg, q.mrg, q.params)
  const flag = (p: string[]) => p.filter((d) => /^SCAN|TEMP B-TREE/.test(d))
  console.log('  plan cur:'); for (const d of pa) console.log('   ', d)
  console.log('  plan mrg:'); for (const d of pb) console.log('   ', d)
  console.log(`  SCAN/TEMP cur=${flag(pa).length} mrg=${flag(pb).length}`)
}

// ---- Lifecycle and idempotency on the merged row ----
console.log('\n== lifecycle on merged row')
const L = merged()
const admit = L.prepare(`INSERT INTO session(session_id, organization_id, owner_key, publication, admitted_host_id, admitted_at, created_at)
  VALUES ($id, $org, $owner, 'published', $host, $now, $now)
  ON CONFLICT(session_id) DO NOTHING
  RETURNING session_id`)
const readAdmission = L.prepare(`SELECT owner_key, admitted_host_id, admitted_at FROM session WHERE organization_id = $org AND session_id = $id AND admitted_at IS NOT NULL`)
// 1. API admits.
console.log(' admit #1 inserted:', admit.all({ $id: 'x', $org: 'org_a', $owner: 'acct:bob', $host: 'vm-1', $now: 1 }).length)
// 2. Retry by same person: no change, same admission.
console.log(' admit retry inserted:', admit.all({ $id: 'x', $org: 'org_a', $owner: 'acct:bob', $host: 'vm-1', $now: 2 }).length, 'stored:', JSON.stringify(readAdmission.get({ $org: 'org_a', $id: 'x' })))
// 3. Another person tries to re-own: DO NOTHING, then the caller compares owner/host -> conflict.
admit.all({ $id: 'x', $org: 'org_a', $owner: 'acct:mallory', $host: 'vm-2', $now: 3 })
const stored = readAdmission.get({ $org: 'org_a', $id: 'x' }) as { owner_key: string; admitted_host_id: string }
console.log(' mallory retry -> owner still', stored.owner_key, stored.admitted_host_id === 'vm-1' ? '(conflict detectable)' : 'BUG')
// 4. Host's start report (provider started). Owner/org/publication never from the report.
const report = L.prepare(`INSERT INTO session(session_id, organization_id, owner_key, publication, started_at, provider, project_path, status, created_at, last_activity_at, runner_host_id)
  VALUES ($id, $org, $reporter, 'published', $now, $provider, $path, 'running', $now, $now, $host)
  ON CONFLICT(session_id) DO UPDATE SET
    started_at = COALESCE(session.started_at, excluded.started_at), provider = excluded.provider, project_path = excluded.project_path,
    status = excluded.status, last_activity_at = MAX(session.last_activity_at, excluded.last_activity_at), runner_host_id = excluded.runner_host_id
  WHERE session.organization_id = excluded.organization_id
  RETURNING owner_key, started_at, provider`)
console.log(' report after admission:', JSON.stringify(report.get({ $id: 'x', $org: 'org_a', $reporter: 'acct:mallory', $now: 10, $provider: 'codex', $path: '-repo', $host: 'vm-1' })))
console.log(' report twice:', JSON.stringify(report.get({ $id: 'x', $org: 'org_a', $reporter: 'acct:mallory', $now: 11, $provider: 'codex', $path: '-repo', $host: 'vm-1' })))
// 5. Report BEFORE admission (delivery raced the admission): the report creates the row with the reporter as owner...
console.log(' report before admission:', JSON.stringify(report.get({ $id: 'y', $org: 'org_a', $reporter: 'acct:bob', $now: 10, $provider: 'codex', $path: '-repo', $host: 'vm-1' })))
console.log(' ...then admission by another person is a no-op (owner kept, admitted_at stays NULL):', admit.all({ $id: 'y', $org: 'org_a', $owner: 'acct:mallory', $host: 'vm-9', $now: 12 }).length, JSON.stringify(L.prepare(`SELECT owner_key, admitted_at FROM session WHERE session_id='y'`).get()))
// 6. State writers on a row that exists from admission: one UPDATE each, no ensureRow.
L.prepare(`UPDATE session SET last_prompt_at = 20, settled_at = NULL, settled_by = NULL WHERE session_id = 'x'`).run()
L.prepare(`UPDATE session SET lead_started_at = COALESCE(lead_started_at, 21) WHERE session_id = 'x'`).run()
L.prepare(`UPDATE session SET lead_started_at = COALESCE(lead_started_at, 99) WHERE session_id = 'x'`).run()
const settle = L.prepare(`UPDATE session SET settled_at = $at, settled_by = $by WHERE session_id = $id AND settled_at IS NULL RETURNING settled_at, settled_by`)
console.log(' settle #1:', JSON.stringify(settle.get({ $at: 30, $by: 'pull-request', $id: 'x' })), 'settle #2:', JSON.stringify(settle.get({ $at: 31, $by: 'task', $id: 'x' })))
console.log(' row:', JSON.stringify(L.prepare(`SELECT owner_key, admitted_at, started_at, last_prompt_at, lead_started_at, settled_at, settled_by FROM session WHERE session_id='x'`).get()))
// 7. "no record yet" readers: today getSessionRecord() is null before start; merged: started_at IS NULL.
console.log(' admitted-not-started visible to record readers?', L.prepare(`SELECT COUNT(*) AS n FROM session WHERE started_at IS NULL`).get())
// 8. A lead mark before the provider starts, on a personal machine: the row is created with no provider (today: a session_leads row with no record).
L.prepare(`INSERT INTO session(session_id, organization_id, owner_key, created_at, lead_started_at) VALUES ('z', 'local', 'host:mac', 40, 40) ON CONFLICT(session_id) DO UPDATE SET lead_started_at = COALESCE(session.lead_started_at, excluded.lead_started_at)`).run()
console.log(' lead before start:', JSON.stringify(L.prepare(`SELECT provider, started_at, lead_started_at FROM session WHERE session_id='z'`).get()))

// ---- Write amplification: indexes touched per hot write ----
console.log('\n== write cost (avg ms, 2000 updates each)')
function bench(db: Database, label: string, sqlText: string) {
  const stmt = db.prepare(sqlText)
  const t0 = performance.now()
  db.transaction(() => { for (let i = 0; i < 2000; i++) stmt.run({ $id: `s${String(i).padStart(5, '0')}`, $now: NOW + i } as never) })()
  console.log(`  ${label}: ${((performance.now() - t0) / 2000 * 1000).toFixed(1)} us/row`)
}
bench(cur, 'cur status+activity (session_records; touches by_activity, api_activity_page, by_place)', `UPDATE session_records SET status = 'idle', last_activity_at = $now WHERE session_id = $id`)
bench(mrg, 'mrg status+activity (session; same 3 indexes)', `UPDATE session SET status = 'idle', last_activity_at = $now WHERE session_id = $id`)
bench(cur, 'cur settle (session_states; touches session_states_settled)', `UPDATE session_states SET settled_at = $now, settled_by = 'task' WHERE session_id = $id`)
bench(mrg, 'mrg settle (session; no index on settled_at)', `UPDATE session SET settled_at = $now, settled_by = 'task' WHERE session_id = $id`)
bench(cur, 'cur ensureRow+prompt (2 statements today)', `INSERT INTO session_states(session_id, organization_id) VALUES ($id, 'local') ON CONFLICT(session_id) DO NOTHING; `)
bench(cur, 'cur prompt UPDATE', `UPDATE session_states SET last_prompt_at = $now, settled_at = NULL, settled_by = NULL WHERE session_id = $id`)
bench(mrg, 'mrg prompt UPDATE (1 statement)', `UPDATE session SET last_prompt_at = $now, settled_at = NULL, settled_by = NULL WHERE session_id = $id`)
bench(cur, 'cur viewed_at', `UPDATE session_states SET viewed_at = $now WHERE session_id = $id`)
bench(mrg, 'mrg viewed_at', `UPDATE session SET viewed_at = $now WHERE session_id = $id`)
console.log(' merged row width (bytes, avg):', (mrg.prepare(`SELECT AVG(LENGTH(session_id)+LENGTH(COALESCE(title,''))+LENGTH(COALESCE(cwd,''))+LENGTH(COALESCE(started_by,''))+200) AS w FROM session`).get() as { w: number }).w.toFixed(0))
