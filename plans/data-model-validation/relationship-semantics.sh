#!/usr/bin/env bash
set -euo pipefail
# Synthetic in-memory model; run from repository root.
python3 - <<'PY'
import sqlite3,json,platform,sys
db=sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
db.executescript("""
CREATE TABLE observations(
 org TEXT NOT NULL, authority TEXT NOT NULL, repo TEXT NOT NULL, num INTEGER NOT NULL,
 title TEXT NOT NULL, state TEXT, PRIMARY KEY(org,authority,repo,num));
CREATE TABLE resource_links(
 org TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
 kind TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', key TEXT NOT NULL,
 relation TEXT NOT NULL DEFAULT 'reference', source TEXT NOT NULL DEFAULT 'manual',
 status TEXT NOT NULL DEFAULT 'active', at INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '',
 via TEXT, pinned INTEGER NOT NULL DEFAULT 0,
 authority TEXT NOT NULL DEFAULT '', pr_repo TEXT, pr_num INTEGER,
 keeps_session INTEGER NOT NULL DEFAULT 0,
 watch_id TEXT, watch_started INTEGER, watch_state TEXT, watch_actor TEXT,
 PRIMARY KEY(org,owner_kind,owner_id,kind,scope,key),
 FOREIGN KEY(org,authority,pr_repo,pr_num) REFERENCES observations(org,authority,repo,num),
 CHECK(keeps_session IN (0,1) AND (keeps_session=0 OR (owner_kind='session' AND kind='pr' AND status='active'))),
 CHECK((pr_repo IS NULL AND pr_num IS NULL) OR (kind='pr' AND pr_repo IS NOT NULL AND pr_num IS NOT NULL)),
 CHECK(watch_id IS NULL AND watch_started IS NULL AND watch_state IS NULL AND watch_actor IS NULL
       OR watch_id IS NOT NULL AND watch_started IS NOT NULL AND watch_state IS NOT NULL
          AND owner_kind='session' AND kind='pr' AND status='active'));
CREATE UNIQUE INDEX one_working_owner ON resource_links(org,scope,key)
 WHERE owner_kind='task' AND kind='session' AND relation='working' AND status='active';
CREATE UNIQUE INDEX one_pin ON resource_links(org,owner_id)
 WHERE owner_kind='task' AND pinned=1 AND status='active';
CREATE UNIQUE INDEX watch_generation ON resource_links(watch_id) WHERE watch_id IS NOT NULL;
CREATE INDEX links_reverse ON resource_links(org,kind,scope,key,owner_kind,owner_id);
CREATE INDEX links_owner ON resource_links(org,owner_kind,owner_id,at DESC);
CREATE INDEX links_pr ON resource_links(org,authority,pr_repo,pr_num,owner_kind,owner_id)
 WHERE kind='pr' AND status='active';
CREATE INDEX links_open ON resource_links(owner_id,org)
 WHERE keeps_session=1;
CREATE INDEX links_via ON resource_links(org,owner_id,via) WHERE via IS NOT NULL;
CREATE TABLE old_task_links(task TEXT,kind TEXT,scope TEXT,key TEXT,title TEXT,at INTEGER,via TEXT,
 PRIMARY KEY(task,kind,scope,key));
CREATE TABLE old_bindings(task TEXT,session TEXT,role TEXT, PRIMARY KEY(task,session));
CREATE TABLE old_pr(session TEXT,repo TEXT,num INTEGER,title TEXT,source TEXT,at INTEGER,state TEXT,
 PRIMARY KEY(session,repo,num));
CREATE INDEX old_open ON old_pr(session)
 WHERE source<>'dismissed' AND (state IS NULL OR state NOT IN ('closed','merged','missing'));
CREATE TABLE old_works(id TEXT PRIMARY KEY,origin TEXT,members TEXT);
CREATE TABLE works(id TEXT PRIMARY KEY,org TEXT,origin TEXT);
""")
checks=[]
def check(name,truth):
 assert truth,name
 checks.append(name)
def rejects(name,sql,args=()):
 try: db.execute(sql,args)
 except sqlite3.IntegrityError: check(name,True)
 else: check(name,False)
def link(owner_kind,owner,kind,key,scope='',at=1,title='',org='o',**extra):
 fields=dict(org=org,owner_kind=owner_kind,owner_id=owner,kind=kind,scope=scope,key=str(key),at=at,title=title,**extra)
 db.execute('INSERT INTO resource_links('+','.join(fields)+') VALUES('+','.join('?' for _ in fields)+')',list(fields.values()))
def observation(org,authority,repo,num,title,state):
 db.execute('INSERT INTO observations VALUES(?,?,?,?,?,?)',(org,authority,repo,num,title,state))
def bind(task,session,role='working',org='o'):
 if org=='o': db.execute('INSERT INTO old_bindings VALUES(?,?,?)',(task,session,role))
 link('task',task,'session',session,org=org,relation=role)
def pr(session,repo,num,at,title,source='manual',state='open',authority='a',org='o'):
 if org=='o': db.execute('INSERT INTO old_pr VALUES(?,?,?,?,?,?,?)',(session,repo,num,title,source,at,state))
 if not db.execute('SELECT 1 FROM observations WHERE org=? AND authority=? AND repo=? AND num=?',(org,authority,repo,num)).fetchone():
  observation(org,authority,repo,num,title,state)
 link('session',session,'pr',num,repo,at,title,org=org,source=source,status='dismissed' if source=='dismissed' else 'active',
      authority=authority,pr_repo=repo,pr_num=num,keeps_session=int(source!='dismissed' and state not in ('closed','merged','missing')))
def taskpr(task,repo,num,at,title):
 db.execute('INSERT INTO old_task_links VALUES(?,?,?,?,?,?,NULL)',(task,'pr',repo,str(num),title,at))
 link('task',task,'pr',num,repo,at,title)
def old_list(task):
 direct=db.execute("SELECT scope,key,title,at,'' FROM old_task_links WHERE task=? AND kind='pr' ORDER BY at DESC,scope,key DESC",(task,)).fetchall()
 inherited=db.execute("""SELECT p.repo,CAST(p.num AS TEXT),p.title,p.at,p.session
 FROM old_pr p JOIN old_bindings b ON b.session=p.session
 WHERE b.task=? AND b.role<>'referenced' AND p.source<>'dismissed'
 ORDER BY p.at DESC,p.repo,p.num DESC""",(task,)).fetchall()
 seen=set(); result=[]
 for r in direct+inherited:
  identity=(r[0].lower(),int(r[1]))
  if identity not in seen: result.append(r);seen.add(identity)
 return sorted(result,key=lambda r:-r[3])
NEW_LIST="""WITH candidates AS (
 SELECT l.scope,l.key,l.title,l.at,'' AS via,0 AS priority FROM resource_links l
 WHERE l.org=?1 AND l.owner_kind='task' AND l.owner_id=?2 AND l.kind='pr' AND l.status='active'
 UNION ALL
 SELECT p.scope,p.key,p.title,p.at,p.owner_id,1 FROM resource_links b JOIN resource_links p
 ON p.org=b.org AND p.owner_kind='session' AND p.owner_id=b.key AND p.kind='pr' AND p.status='active'
 WHERE b.org=?1 AND b.owner_kind='task' AND b.owner_id=?2 AND b.kind='session'
 AND b.relation='working' AND b.status='active'
), picked AS (
 SELECT *,ROW_NUMBER() OVER(PARTITION BY lower(scope),CAST(key AS INTEGER)
 ORDER BY priority,at DESC,via) AS n FROM candidates)
 SELECT scope,key,title,at,via FROM picked WHERE n=1 ORDER BY at DESC,priority,scope,CAST(key AS INTEGER) DESC"""
def new_list(task,org='o'): return db.execute(NEW_LIST,(org,task)).fetchall()
bind('t','s1');bind('t','s2');bind('t','sref','referenced')
pr('s1','github/x/r',1,90,'inherited')
pr('s2','github/x/r',1,80,'older duplicate')
pr('s2','github/x/r',2,70,'second')
pr('sref','github/x/r',3,100,'reference excluded')
pr('s1','github/x/r',4,110,'dismissed','dismissed')
taskpr('t','github/x/r',1,10,'direct wins even older')
taskpr('t','github/x/r',5,60,'direct second')
check('PR result and order parity',old_list('t')==new_list('t'))
check('direct beats newer inherited',new_list('t')[-1][2]=='direct wins even older')
check('reference excluded',all(r[1]!='3' for r in new_list('t')))
check('dismissed excluded',all(r[1]!='4' for r in new_list('t')))
def rediscover(incoming):
 old=db.execute("SELECT source FROM old_pr WHERE session='s1' AND num=4").fetchone()[0]
 if incoming!='branch' and old in ('branch','dismissed'):
  db.execute("UPDATE old_pr SET source=? WHERE session='s1' AND num=4",(incoming,))
 db.execute("""UPDATE resource_links SET source=?,status='active',keeps_session=1
 WHERE owner_kind='session' AND owner_id='s1' AND key='4'
 AND ?<>'branch' AND (source='branch' OR status='dismissed')""",(incoming,incoming))
rediscover('branch')
check('branch cannot revive dismissal',old_list('t')==new_list('t') and all(r[1]!='4' for r in new_list('t')))
rediscover('manual')
check('explicit revival parity',old_list('t')==new_list('t') and any(r[1]=='4' for r in new_list('t')))
taskpr('t','/checkout/one',9,30,'unresolved one');taskpr('t','/checkout/two',9,20,'unresolved two')
check('unresolved path identity retained',old_list('t')==new_list('t') and len([r for r in new_list('t') if r[1]=='9'])==2)
check('unresolved has no invented observation',db.execute("SELECT COUNT(*) FROM resource_links WHERE scope LIKE '/checkout/%' AND pr_repo IS NOT NULL").fetchone()[0]==0)
observation('o','a','github/resolved/r',9,'resolved','closed')
db.execute("""UPDATE resource_links SET authority='a',pr_repo='github/resolved/r',pr_num=9
 WHERE owner_id='t' AND scope='/checkout/one' AND key='9'""")
check('resolution attaches qualified observation without merging another path',db.execute("SELECT COUNT(*) FROM resource_links WHERE owner_id='t' AND key='9'").fetchone()[0]==2)
for key,at in [('remove',1),('claim',2),('follow',3)]:
 db.execute("INSERT INTO old_task_links VALUES('t','work','',?,?,?,'s1')",(key,key,at))
 link('task','t','work',key,at=at,title=key,via='s1')
db.execute("DELETE FROM old_task_links WHERE key='remove'")
db.execute("DELETE FROM resource_links WHERE kind='work' AND key='remove'")
# Rebinding an existing session is a no-op; no adoption occurs.
db.execute("INSERT OR IGNORE INTO old_bindings VALUES('t','s1','working')")
db.execute("""INSERT INTO resource_links(org,owner_kind,owner_id,kind,scope,key,at,relation)
 VALUES('o','task','t','session','','s1',1,'working') ON CONFLICT DO NOTHING""")
check('removed output stays removed on repeated binding',db.execute("SELECT COUNT(*) FROM resource_links WHERE kind='work' AND key='remove'").fetchone()[0]==0)
db.execute("UPDATE old_task_links SET via=NULL WHERE key='claim'")
db.execute("UPDATE resource_links SET via=NULL WHERE kind='work' AND key='claim'")
db.execute("DELETE FROM old_bindings WHERE task='t' AND session='s1'")
db.execute("DELETE FROM old_task_links WHERE task='t' AND via='s1'")
db.execute("DELETE FROM resource_links WHERE owner_kind='task' AND owner_id='t' AND kind='session' AND key='s1'")
db.execute("DELETE FROM resource_links WHERE owner_kind='task' AND owner_id='t' AND via='s1'")
oldout=db.execute("SELECT key FROM old_task_links WHERE task='t' AND kind='work' ORDER BY key").fetchall()
newout=db.execute("SELECT key FROM resource_links WHERE owner_kind='task' AND owner_id='t' AND kind='work' ORDER BY key").fetchall()
check('claimed output remains; unclaimed leaves',oldout==newout==[('claim',)])
check('PR parity after session departure',old_list('t')==new_list('t'))
db.execute("INSERT INTO old_works VALUES('w','origin','[\"origin\",\"other\"]')")
db.execute("INSERT INTO works VALUES('w','o','origin')")
link('session','origin','work','w',relation='member');link('session','other','work','w',relation='member')
db.execute("UPDATE old_works SET members='[\"other\"]' WHERE id='w'")
db.execute("DELETE FROM resource_links WHERE owner_kind='session' AND owner_id='origin' AND kind='work'")
members=[r[0] for r in db.execute("SELECT owner_id FROM resource_links WHERE owner_kind='session' AND kind='work' AND key='w'")]
check('origin unlink hides artifact membership',members==json.loads(db.execute("SELECT members FROM old_works").fetchone()[0])==['other'])
access=db.execute("""SELECT origin FROM works WHERE id='w' UNION
 SELECT owner_id FROM resource_links WHERE org='o' AND kind='work' AND key='w'""").fetchall()
check('origin remains in access union',set(access)=={('origin',),('other',)})
pr('otherorg','github/x/r',1,1,'other org closed',state='closed',org='p')
pr('otherauthority','github/x/r',1,1,'authority b missing',state='missing',authority='b')
qualified=db.execute("""SELECT l.owner_id,o.state FROM resource_links l JOIN observations o
 ON (o.org,o.authority,o.repo,o.num)=(l.org,l.authority,l.pr_repo,l.pr_num)
 WHERE l.owner_kind='session' AND l.owner_id IN ('s1','otherorg','otherauthority') AND l.key='1'
 ORDER BY l.owner_id""").fetchall()
check('org and authority observations separated',qualified==[('otherauthority','missing'),('otherorg','closed'),('s1','open')])
check('org boundary in task query',new_list('t','p')==[])
rejects('cross-authority observation FK rejects',"""UPDATE resource_links SET authority='no-such-authority'
 WHERE owner_id='otherauthority' AND kind='pr'""")
rejects('cross-org observation FK rejects',"""UPDATE resource_links SET org='no-such-org'
 WHERE owner_id='otherorg' AND kind='pr'""")
rejects('one active working owner',"""INSERT INTO resource_links(org,owner_kind,owner_id,kind,scope,key,relation,at)
 VALUES('o','task','different','session','','s2','working',1)""")
link('task','different','session','s2',relation='referenced')
check('reference does not claim ownership',db.execute("SELECT COUNT(*) FROM resource_links WHERE kind='session' AND key='s2'").fetchone()[0]==2)
db.execute("UPDATE resource_links SET status='historical' WHERE owner_kind='task' AND owner_id='t' AND kind='session' AND key='s2'")
db.execute("UPDATE resource_links SET relation='working' WHERE owner_kind='task' AND owner_id='different' AND kind='session' AND key='s2'")
check('historical owner permits transfer',db.execute("SELECT owner_id FROM resource_links WHERE kind='session' AND key='s2' AND relation='working' AND status='active'").fetchall()==[('different',)])
link('task','p-task','session','s2',org='p',relation='working')
check('working owner uniqueness scoped by org',db.execute("SELECT COUNT(*) FROM resource_links WHERE key='s2' AND relation='working' AND status='active'").fetchone()[0]==2)
WATCH="""UPDATE resource_links SET watch_id=?,watch_started=1,watch_state='{}',watch_actor=?
 WHERE org='o' AND owner_kind='session' AND owner_id='s2' AND kind='pr' AND key='2'"""
db.execute(WATCH,('generation-1','person-a'))
db.execute(WATCH,('generation-2','person-b'))
stale=db.execute("UPDATE resource_links SET watch_state='{\"old\":true}' WHERE watch_id='generation-1'").rowcount
check('stale watch update rejected',stale==0)
check('watch restart keeps new actor',db.execute("SELECT watch_actor FROM resource_links WHERE watch_id='generation-2'").fetchone()==('person-b',))
check('current watch update accepted',db.execute("UPDATE resource_links SET watch_state='{\"new\":true}' WHERE watch_id='generation-2'").rowcount==1)
check('stale watch end rejected',db.execute("""UPDATE resource_links SET watch_id=NULL,watch_started=NULL,watch_state=NULL,watch_actor=NULL
 WHERE watch_id='generation-1'""").rowcount==0)
rejects('cannot dismiss without clearing watch',"""UPDATE resource_links SET status='dismissed' WHERE watch_id='generation-2'""")
db.execute("""UPDATE resource_links SET status='dismissed',keeps_session=0,watch_id=NULL,watch_started=NULL,watch_state=NULL,watch_actor=NULL
 WHERE watch_id='generation-2'""")
check('dismissal clears all watch columns',db.execute("SELECT COUNT(*) FROM resource_links WHERE watch_id IS NOT NULL").fetchone()[0]==0)
# Qualification prevents a principal-relative update from altering the wrong candidate projection.
db.execute("""UPDATE resource_links SET keeps_session=0
 WHERE org='o' AND authority='a' AND pr_repo='github/x/r' AND pr_num=1""")
db.execute("UPDATE observations SET state='closed' WHERE org='o' AND authority='a' AND repo='github/x/r' AND num=1")
check('qualified cache update leaves other authority unchanged',db.execute("SELECT state FROM observations WHERE org='o' AND authority='b' AND num=1").fetchone()==('missing',))
rejects('watch cannot be stored on task',"""UPDATE resource_links SET watch_id='bad',watch_started=1,watch_state='{}'
 WHERE owner_kind='task' AND kind='pr' AND key='5'""")
rejects('partial canonical identity rejected',"""UPDATE resource_links SET pr_repo='repo',pr_num=NULL
 WHERE owner_kind='task' AND kind='pr' AND key='5'""")

# Ties expose a genuine mistake in the original proposed UNION ordering.
taskpr('ties','github/ties/r',2,12,'two')
taskpr('ties','github/ties/r',10,12,'ten')
check('negative control: numeric direct tie order differs',old_list('ties')!=new_list('ties'))
NEW_LIST=NEW_LIST.replace('ORDER BY at DESC,priority,scope,CAST(key AS INTEGER) DESC',
 'ORDER BY at DESC,priority,scope,CASE WHEN priority=0 THEN key END DESC,CASE WHEN priority=1 THEN CAST(key AS INTEGER) END DESC')
check('corrected direct tie order parity',old_list('ties')==new_list('ties'))
bind('ties','tie-session')
pr('tie-session','github/ties/other',2,12,'inherited two')
pr('tie-session','github/ties/other',10,12,'inherited ten')
check('mixed direct/inherited timestamp tie parity',old_list('ties')==new_list('ties'))
rejects('non-session cannot keep a session listed',"""UPDATE resource_links SET keeps_session=1
 WHERE owner_kind='task' AND kind='pr' AND key='5'""")
check('dismissed edge no longer a candidate',db.execute("""SELECT keeps_session FROM resource_links
 WHERE org='o' AND owner_kind='session' AND owner_id='s2' AND key='2'""").fetchone()==(0,))
# The same transaction owns the observation and its one-bit read projection.
def observe(state,title):
 db.execute("UPDATE observations SET state=?,title=? WHERE org='o' AND authority='a' AND repo='github/x/r' AND num=1",(state,title))
 flag=int(state not in ('closed','merged','missing'))
 return db.execute("""UPDATE resource_links SET keeps_session=?
 WHERE org='o' AND authority='a' AND pr_repo='github/x/r' AND pr_num=1
 AND owner_kind='session' AND kind='pr' AND status='active' AND keeps_session<>?""",(flag,flag)).rowcount
check('state transition updates two linked candidate bits',observe('open','new title')==2)
check('title-only observation writes no link projection',observe('open','newer title')==0)
check('authority b remains missing and excluded',db.execute("SELECT keeps_session FROM resource_links WHERE owner_id='otherauthority'").fetchone()==(0,))
# Compare observed session payloads to the current fan-out update behavior.
db.execute("UPDATE old_pr SET title='newer title',state='open' WHERE repo='github/x/r' AND num=1 AND session IN ('s1','s2')")
old=db.execute("SELECT session,title,state FROM old_pr WHERE session IN ('s1','s2') AND num=1 ORDER BY session").fetchall()
new=db.execute("""SELECT l.owner_id,p.title,p.state FROM resource_links l JOIN observations p
 ON (p.org,p.authority,p.repo,p.num)=(l.org,l.authority,l.pr_repo,l.pr_num)
 WHERE l.org='o' AND l.authority='a' AND l.owner_id IN ('s1','s2') AND l.kind='pr' AND l.key='1'
 ORDER BY l.owner_id""").fetchall()
check('observed payload fanout parity',old==new)
db.execute('SAVEPOINT atomic_observation')
observe('closed','rollback title')
db.execute('ROLLBACK TO atomic_observation');db.execute('RELEASE atomic_observation')
check('rollback restores observation',db.execute("SELECT state,title FROM observations WHERE org='o' AND authority='a' AND repo='github/x/r' AND num=1").fetchone()==('open','newer title'))
check('rollback restores candidate projection',db.execute("SELECT SUM(keeps_session) FROM resource_links WHERE owner_id IN ('s1','s2') AND kind='pr' AND key='1'").fetchone()[0]==2)
db.execute("""CREATE TABLE old_watches(session TEXT,repo TEXT,num INTEGER,watch_id TEXT,started INTEGER,state TEXT,actor TEXT,
 PRIMARY KEY(session,repo,num))""")
db.execute("INSERT INTO old_watches VALUES('s1','github/x/r',1,'watch-parity',55,'{\"headSha\":null}','person')")
db.execute("""UPDATE resource_links SET watch_id='watch-parity',watch_started=55,watch_state='{"headSha":null}',watch_actor='person'
 WHERE org='o' AND owner_kind='session' AND owner_id='s1' AND kind='pr' AND key='1'""")
old=db.execute("SELECT session,repo,num,watch_id,started,state,actor FROM old_watches").fetchall()
new=db.execute("""SELECT owner_id,pr_repo,pr_num,watch_id,watch_started,watch_state,watch_actor FROM resource_links WHERE watch_id IS NOT NULL""").fetchall()
check('embedded watch payload equals separate table payload',old==new)
check('candidate index selected',any('links_open' in r[3] for r in db.execute("""EXPLAIN QUERY PLAN SELECT 1 FROM resource_links
 WHERE org='o' AND owner_id='s1' AND keeps_session=1 LIMIT 1""")))

print(json.dumps({'environment':{'python':sys.version.split()[0],'sqlite':sqlite3.sqlite_version,'os':platform.platform()},
 'assertions':len(checks),'status':'PASS','checks':checks},indent=2))

PY
