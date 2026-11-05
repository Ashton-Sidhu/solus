#!/usr/bin/env bash
set -euo pipefail
# Run from the Solus repository root. All SQLite databases are in memory.
python3 - <<'PY'
import sqlite3, json, platform
j = lambda x: json.dumps(x, separators=(',', ':'), ensure_ascii=False)
c = sqlite3.connect(':memory:', isolation_level=None)
c.row_factory = sqlite3.Row
c.executescript("""
CREATE TABLE subjects(
 org TEXT,kind TEXT,id TEXT,part TEXT DEFAULT '',
 next_position INTEGER NOT NULL DEFAULT 0,location TEXT,
 comments_updated_at INTEGER NOT NULL DEFAULT 0,
 external_comments TEXT NOT NULL DEFAULT '{}',
 external_version INTEGER NOT NULL DEFAULT 0,
 link_version INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(org,kind,id,part));
CREATE TABLE comment_threads(
 org TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('task','work','plan')),
 id TEXT NOT NULL,part TEXT NOT NULL DEFAULT '',thread_id TEXT NOT NULL,
 body TEXT NOT NULL,author TEXT NOT NULL,source TEXT NOT NULL,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 position INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 external_scope TEXT,external_id TEXT,origin_session_id TEXT,
 delivery_state TEXT NOT NULL
   CHECK(delivery_state IN ('private','pending','sent')),
 review TEXT NOT NULL DEFAULT '{}',
 PRIMARY KEY(org,kind,id,part,thread_id),
 CHECK((external_scope IS NULL)=(external_id IS NULL)));
CREATE UNIQUE INDEX thread_external
 ON comment_threads(org,kind,id,part,external_scope,external_id)
 WHERE external_id IS NOT NULL;
CREATE INDEX thread_order
 ON comment_threads(org,kind,id,part,position,thread_id);
CREATE INDEX task_order
 ON comment_threads(org,kind,id,part,created_at,thread_id)
 WHERE kind='task';
CREATE INDEX thread_pending
 ON comment_threads(org,kind,id,part,created_at,thread_id)
 WHERE delivery_state='pending';
CREATE TABLE indexed_plans(
 org TEXT,id TEXT,part TEXT,PRIMARY KEY(org,id,part));
""")
SUB = "org=? AND kind=? AND id=? AND part=?"
ROW = SUB + " AND thread_id=?"
passed = []

def check(name, value):
    if not value:
        raise AssertionError(name)
    passed.append(name)

def add(s, t, body='note', at=10, source='local',
        delivery='private', ext=None, review=None):
    c.execute(
        "INSERT OR IGNORE INTO subjects(org,kind,id,part) VALUES(?,?,?,?)", s)
    c.execute("BEGIN")
    try:
        if c.execute("SELECT 1 FROM comment_threads WHERE " + ROW,
                     (*s, t)).fetchone():
            c.execute("COMMIT")
            return False
        position = c.execute(
            "UPDATE subjects SET next_position=next_position+1 WHERE " +
            SUB + " RETURNING next_position", s).fetchone()[0]
        values = (*s, t, body, j({'kind': 'system'}), source, at, at,
                  position, 1, ext[0] if ext else None,
                  ext[1] if ext else None, None, delivery, j(review or {}))
        changed = c.execute(
            "INSERT OR IGNORE INTO comment_threads VALUES(" +
            ",".join("?" * 17) + ")", values).rowcount
        c.execute("COMMIT")
        return bool(changed)
    except:
        c.execute("ROLLBACK")
        raise

def rows(s):
    order = "created_at,thread_id" if s[1] == 'task' else "position,thread_id"
    return list(c.execute(
        "SELECT * FROM comment_threads WHERE " + SUB + " ORDER BY " + order, s))

def get(s, t):
    return c.execute("SELECT * FROM comment_threads WHERE " + ROW,
                     (*s, t)).fetchone()

def cas(s, t, version, body, review):
    return c.execute(
        "UPDATE comment_threads SET body=?,review=?,version=version+1,"
        "updated_at=20 WHERE " + ROW + " AND version=?",
        (body, j(review), *s, t, version)).rowcount

def remove(s, t):
    return c.execute(
        "DELETE FROM comment_threads WHERE " + ROW +
        " AND source='local' AND external_id IS NULL"
        " AND delivery_state IN ('private','pending')", (*s, t)).rowcount

def project(r):
    out = dict(id=r['thread_id'], comment=r['body'],
               author=json.loads(r['author']), createdAt=r['created_at'])
    out.update(json.loads(r['review']))
    return out

w = ('o', 'work', 'w', '')
t = ('o', 'task', 't', '')
p = ('o', 'plan', 's', 'tool')
check('empty response', rows(w) == [])
add(w, 'z', at=30, review={'selectedText': 'q', 'pin': {'x': .2, 'y': .4}})
add(w, 'a', at=1, review={'selectedText': 'r', 'replies': [], 'readBy': []})
legacy = [
    dict(id='z', comment='note', author={'kind': 'system'}, createdAt=30,
         selectedText='q', pin={'x': .2, 'y': .4}),
    dict(id='a', comment='note', author={'kind': 'system'}, createdAt=1,
         selectedText='r', replies=[], readBy=[])]
check('work ordered full response parity',
      [project(r) for r in rows(w)] == legacy)
add(p, 'z', at=30)
add(p, 'a', at=1)
check('plan array order preserved',
      [r['thread_id'] for r in rows(p)] == ['z', 'a'])
for name, at in [('z', 9), ('b', 2), ('a', 2)]:
    add(t, name, at=at)
check('task timestamp ID order',
      [r['thread_id'] for r in rows(t)] == ['a', 'b', 'z'])
check('first thread position', get(w, 'z')['position'] == 1)
check('second thread position', get(w, 'a')['position'] == 2)
check('duplicate task replay no insert', not add(t, 'a', body='replayed'))
check('replay body unchanged', get(t, 'a')['body'] == 'note')
before = c.execute(
    "SELECT next_position FROM subjects WHERE " + SUB, t).fetchone()[0]
add(t, 'a')
check('replay keeps ordering counter', c.execute(
    "SELECT next_position FROM subjects WHERE " + SUB, t).fetchone()[0] == before)

e = ('github:ticket-1', '42')
check('first external insert',
      add(t, 'ext', source='external', delivery='sent', ext=e))
check('duplicate external ID ignored',
      not add(t, 'ext-replay', source='external', delivery='sent', ext=e))
for name, s in [
    ('other org', ('other', 'task', 't', '')),
    ('other task', ('o', 'task', 't2', '')),
    ('other part', ('o', 'plan', 's', 'tool2'))
]:
    check('external uniqueness ' + name,
          add(s, 'ext', source='external', delivery='sent', ext=e))
check('external scope separates provider target',
      add(t, 'ext-other', source='external', delivery='sent',
          ext=('jira:ticket-2', '42')))

add(t, 'private')
add(t, 'queued', delivery='pending')
add(t, 'sent', delivery='sent', ext=('github:ticket-1', '43'))
check('delete private', remove(t, 'private') == 1)
check('delete pending unpublished matches current task rule',
      remove(t, 'queued') == 1)
check('refuse sent local delete', remove(t, 'sent') == 0)
check('refuse imported external delete', remove(t, 'ext') == 0)

check('queue private', c.execute(
    "UPDATE comment_threads SET delivery_state='pending',version=version+1"
    " WHERE " + ROW + " AND delivery_state='private' AND external_id IS NULL",
    (*t, 'a')).rowcount == 1)
check('queue duplicate no change', c.execute(
    "UPDATE comment_threads SET delivery_state='pending' WHERE " + ROW +
    " AND delivery_state='private'", (*t, 'a')).rowcount == 0)
check('pending narrow projection', [
    tuple(r) for r in c.execute(
        "SELECT thread_id,body FROM comment_threads WHERE " + SUB +
        " AND delivery_state='pending' ORDER BY created_at,thread_id", t)
] == [('a', 'note')])
check('acknowledge pending', c.execute(
    "UPDATE comment_threads SET delivery_state='sent',external_scope=?,"
    "external_id=?,version=version+1 WHERE " + ROW +
    " AND delivery_state='pending'",
    ('github:ticket-1', '44', *t, 'a')).rowcount == 1)
check('ack import dedupes',
      not add(t, 'reimport', source='external', delivery='sent',
              ext=('github:ticket-1', '44')))

old = get(w, 'z')
payload = json.loads(old['review'])
payload['replies'] = [{'id': 'r1', 'text': 'first'}]
check('first reply CAS',
      cas(w, 'z', old['version'], old['body'], payload) == 1)
check('stale reply rejected', cas(
    w, 'z', old['version'], old['body'],
    {'replies': [{'id': 'r2', 'text': 'second'}]}) == 0)
now = get(w, 'z')
payload = json.loads(now['review'])
payload['replies'].append({'id': 'r2', 'text': 'second'})
check('reply reapply CAS',
      cas(w, 'z', now['version'], now['body'], payload) == 1)
check('both replies retained',
      [x['id'] for x in json.loads(get(w, 'z')['review'])['replies']]
      == ['r1', 'r2'])
check('stale edit rejected', cas(w, 'z', old['version'], 'edited', {}) == 0)
now = get(w, 'z')
check('explicit edit reapply',
      cas(w, 'z', now['version'], 'edited', json.loads(now['review'])) == 1)
check('edit preserved replies',
      len(json.loads(get(w, 'z')['review'])['replies']) == 2)
check('independent thread version unchanged', get(w, 'a')['version'] == 1)
check('independent thread old version works',
      cas(w, 'a', 1, 'independent', json.loads(get(w, 'a')['review'])) == 1)

before = get(w, 'z')['version']
c.execute(
    "UPDATE comment_threads SET review=json_set(review,'$.resolvedAt',30,"
    "'$.resolvedBy',json(?)),version=version+1 WHERE " + SUB +
    " AND json_extract(review,'$.resolvedAt') IS NULL",
    (j({'kind': 'system'}), *w))
check('resolve all sets every open thread',
      all(json.loads(r['review'])['resolvedAt'] == 30 for r in rows(w)))
check('resolve all bumps versions', get(w, 'z')['version'] == before + 1)
check('resolve all repeat no change', c.execute(
    "UPDATE comment_threads SET review=json_set(review,'$.resolvedAt',31),"
    "version=version+1 WHERE " + SUB +
    " AND json_extract(review,'$.resolvedAt') IS NULL", w).rowcount == 0)

before = [dict(r) for r in rows(w)]
check('external refresh CAS', c.execute(
    "UPDATE subjects SET external_comments=?,external_version=external_version+1"
    " WHERE " + SUB + " AND external_version=0 AND link_version=0",
    (j({'threads': [{'id': 'external'}], 'operations': []}), *w)).rowcount == 1)
check('refresh preserves private threads', [dict(r) for r in rows(w)] == before)
check('stale external refresh refused', c.execute(
    "UPDATE subjects SET external_comments='{}' WHERE " + SUB +
    " AND external_version=0", w).rowcount == 0)
c.execute("UPDATE subjects SET link_version=1 WHERE " + SUB, w)
check('relink blocks old refresh', c.execute(
    "UPDATE subjects SET external_comments='{}' WHERE " + SUB +
    " AND link_version=0", w).rowcount == 0)
now = get(w, 'a')
cas(w, 'a', now['version'], 'private edit', json.loads(now['review']))
check('private edit preserves external state', json.loads(c.execute(
    "SELECT external_comments FROM subjects WHERE " + SUB, w
).fetchone()[0])['threads'] == [{'id': 'external'}])

c.execute("INSERT INTO indexed_plans VALUES(?,?,?)", (p[0], p[2], p[3]))
c.execute("DELETE FROM indexed_plans")
check('index rebuild retains plan comments', len(rows(p)) == 2)
c.execute("UPDATE subjects SET location='remote' WHERE " + SUB, w)
check('work move retains comments', len(rows(w)) == 2)
check('moved work write admission rejects', c.execute(
    "SELECT 1 FROM subjects WHERE " + SUB + " AND location IS NULL", w
).fetchone() is None)
c.execute("BEGIN")
c.execute("DELETE FROM comment_threads WHERE " + SUB, t)
c.execute("UPDATE subjects SET location='remote' WHERE " + SUB, t)
c.execute("COMMIT")
check('task move removes source comments', rows(t) == [])
c.execute("BEGIN")
c.execute("DELETE FROM comment_threads WHERE " + SUB, w)
c.execute("DELETE FROM subjects WHERE " + SUB, w)
c.execute("COMMIT")
check('work delete removes comments', rows(w) == [])
check('other resource survives delete', len(rows(p)) == 2)

queries = [
    ('ordered work', "SELECT * FROM comment_threads WHERE " + SUB +
     " ORDER BY position,thread_id", w),
    ('ordered task', "SELECT * FROM comment_threads WHERE " + SUB +
     " AND kind='task' ORDER BY created_at,thread_id", t),
    ('pending', "SELECT thread_id,body FROM comment_threads WHERE " + SUB +
     " AND delivery_state='pending' ORDER BY created_at,thread_id", t),
    ('CAS', "UPDATE comment_threads SET body=?,version=version+1 WHERE " +
     ROW + " AND version=?", ('x', *p, 'a', 1)),
    ('external identity', "SELECT thread_id FROM comment_threads WHERE " +
     SUB + " AND external_scope=? AND external_id=?", (*t, *e))]
for name, query, args in queries:
    print('PLAN', name, [
        r['detail'] for r in c.execute('EXPLAIN QUERY PLAN ' + query, args)])
print('ENV', platform.python_version(), sqlite3.sqlite_version, platform.machine())
print('PASSED', len(passed), 'FAILED', 0)
print('ASSERTIONS', j(passed))
PY
