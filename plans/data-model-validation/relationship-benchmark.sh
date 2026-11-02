#!/usr/bin/env bash
set -euo pipefail
# Synthetic in-memory model; run from repository root.
python3 - <<'PY'
import sqlite3,time,statistics,json,platform,sys
N=10000
OPEN="(p.state IS NULL OR p.state NOT IN ('merged','closed','missing'))"
LIVE="l.owner_kind='session' AND l.kind='pr' AND l.status='active'"
queries={
 'old':"""SELECT s.id FROM sessions s WHERE s.org='o' AND (s.recent=1 OR EXISTS(
 SELECT 1 FROM old_pr p WHERE p.session_id=s.id AND p.source<>'dismissed'
 AND (p.state IS NULL OR p.state NOT IN ('merged','closed','missing'))))
 ORDER BY s.id LIMIT 200""",
 'join':"""SELECT s.id FROM sessions s WHERE s.org='o' AND (s.recent=1 OR EXISTS(
 SELECT 1 FROM resource_links l LEFT JOIN observations p
 ON (p.org,p.authority,p.repo,p.num)=(l.org,l.authority,l.pr_repo,l.pr_num)
 WHERE l.org=s.org AND l.owner_id=s.id AND l.owner_kind='session' AND l.kind='pr' AND l.status='active'
 AND (p.state IS NULL OR p.state NOT IN ('merged','closed','missing'))))
 ORDER BY s.id LIMIT 200""",
 'set':"""WITH candidates AS MATERIALIZED (
 SELECT l.owner_id FROM observations p JOIN resource_links l
 ON (p.org,p.authority,p.repo,p.num)=(l.org,l.authority,l.pr_repo,l.pr_num)
 WHERE p.org='o' AND (p.state IS NULL OR p.state NOT IN ('merged','closed','missing'))
 AND l.owner_kind='session' AND l.kind='pr' AND l.status='active'
 UNION SELECT l.owner_id FROM resource_links l WHERE l.org='o'
 AND l.owner_kind='session' AND l.kind='pr' AND l.status='active' AND l.pr_repo IS NULL)
 SELECT s.id FROM sessions s WHERE s.org='o' AND (s.recent=1 OR s.id IN (SELECT owner_id FROM candidates))
 ORDER BY s.id LIMIT 200""",
 'cached':"""SELECT s.id FROM sessions s WHERE s.org='o' AND (s.recent=1 OR EXISTS(
 SELECT 1 FROM resource_links l WHERE l.org=s.org AND l.owner_id=s.id
 AND l.keeps_session=1))
 ORDER BY s.id LIMIT 200"""
}
ddl="""
CREATE TABLE sessions(id TEXT PRIMARY KEY,org TEXT NOT NULL,recent INTEGER NOT NULL);
CREATE INDEX session_org ON sessions(org,id);
CREATE TABLE old_pr(session_id TEXT,repo TEXT,num INTEGER,source TEXT,state TEXT,title TEXT,
 PRIMARY KEY(session_id,repo,num));
CREATE INDEX old_reverse ON old_pr(repo,num);
CREATE INDEX old_open ON old_pr(session_id) WHERE source<>'dismissed'
 AND (state IS NULL OR state NOT IN ('merged','closed','missing'));
CREATE TABLE observations(org TEXT,authority TEXT,repo TEXT,num INTEGER,state TEXT,title TEXT,
 PRIMARY KEY(org,authority,repo,num));
CREATE INDEX observation_open ON observations(org,authority,repo,num)
 WHERE state IS NULL OR state NOT IN ('merged','closed','missing');
CREATE TABLE resource_links(
 org TEXT,owner_kind TEXT,owner_id TEXT,kind TEXT,scope TEXT,key TEXT,status TEXT,
 authority TEXT,pr_repo TEXT,pr_num INTEGER,keeps_session INTEGER,
 watch_id TEXT,watch_started INTEGER,watch_state TEXT,watch_actor TEXT,
 CHECK(keeps_session=0 OR (owner_kind='session' AND kind='pr' AND status='active')),
 PRIMARY KEY(org,owner_kind,owner_id,kind,scope,key),
 FOREIGN KEY(org,authority,pr_repo,pr_num) REFERENCES observations(org,authority,repo,num));
CREATE INDEX new_pr_owner ON resource_links(org,owner_id,authority,pr_repo,pr_num)
 WHERE owner_kind='session' AND kind='pr' AND status='active';
CREATE INDEX new_pr_reverse ON resource_links(org,authority,pr_repo,pr_num,owner_id)
 WHERE owner_kind='session' AND kind='pr' AND status='active';
CREATE INDEX new_unresolved ON resource_links(org,owner_id)
 WHERE owner_kind='session' AND kind='pr' AND status='active' AND pr_repo IS NULL;
CREATE INDEX new_open ON resource_links(owner_id,org)
 WHERE keeps_session=1;
"""
def stats(xs):
 return {'median_ms':round(statistics.median(xs),4),'p90_ms':round(sorted(xs)[int(.9*(len(xs)-1))],4)}
out=[];plans={};assertions=0
for fan in [1,10,100]:
 db=sqlite3.connect(':memory:');db.execute('PRAGMA foreign_keys=ON');db.executescript(ddl)
 db.executemany('INSERT INTO sessions VALUES(?,?,?)',[(f'{i:026d}','o',int(i%1000==999)) for i in range(N)])
 P=N//fan
 db.executemany("INSERT INTO observations VALUES('o','a','repo',?,'closed','title')",[(i+1,) for i in range(P)])
 old=[];new=[]
 for sid in range(P):
  for j in range(fan):
   num=(sid+j)%P+1
   old.append((f'{sid:026d}','repo',num,'manual','closed','title'))
   new.append(('o','session',f'{sid:026d}','pr','repo',str(num),'active','a','repo',num,0,None,None,None,None))
 db.executemany('INSERT INTO old_pr VALUES(?,?,?,?,?,?)',old)
 db.executemany('INSERT INTO resource_links VALUES('+','.join('?'*15)+')',new)
 db.commit();db.execute('ANALYZE')
 for mode in ['closed','one_open','all_unknown']:
  state= "'closed'" if mode!='all_unknown' else 'NULL'
  db.execute('UPDATE observations SET state='+state)
  db.execute('UPDATE old_pr SET state='+state)
  db.execute('UPDATE resource_links SET keeps_session=?',(int(mode=='all_unknown'),))
  if mode=='one_open':
   db.execute("UPDATE observations SET state='open' WHERE num=1")
   db.execute("UPDATE old_pr SET state='open' WHERE num=1")
   db.execute("UPDATE resource_links SET keeps_session=1 WHERE pr_num=1")
  db.commit()
  expected=db.execute(queries['old']).fetchall()
  for name,q in queries.items():
   assert db.execute(q).fetchall()==expected,(fan,mode,name)
   assertions+=1
   for _ in range(2):db.execute(q).fetchall()
  timings={name:[] for name in queries}
  names=list(queries)
  for rep in range(15):
   for name in names[rep%4:]+names[:rep%4]:
    start=time.perf_counter_ns();db.execute(queries[name]).fetchall()
    timings[name].append((time.perf_counter_ns()-start)/1e6)
  out.append({'fanout':fan,'mode':mode,'sessions':N,'links':N,'observations':P,
              'rows':len(expected),'reads':{k:stats(v) for k,v in timings.items()}})
  if fan==100 and mode=='closed':
   plans={name:[r[3] for r in db.execute('EXPLAIN QUERY PLAN '+q)] for name,q in queries.items()}
 # All unknown: transition num=1 to closed, rolled back on each trial.
 # Measure mutation/transaction cost only; no network, notifications, or fsync.
 writes={
 'old_title':[("UPDATE old_pr SET title='changed' WHERE repo='repo' AND num=1",())],
 'new_title':[("UPDATE observations SET title='changed' WHERE org='o' AND authority='a' AND repo='repo' AND num=1",())],
 'old_close':[("UPDATE old_pr SET state='closed' WHERE repo='repo' AND num=1",())],
 'new_close_cached':[
  ("UPDATE observations SET state='closed' WHERE org='o' AND authority='a' AND repo='repo' AND num=1",()),
  ("""UPDATE resource_links SET keeps_session=0 WHERE org='o' AND authority='a' AND pr_repo='repo'
  AND pr_num=1 AND owner_kind='session' AND kind='pr' AND status='active' AND keeps_session<>0""",())]
 }
 wt={name:[] for name in writes};rowcounts={}
 for rep in range(45):
  names=list(writes)
  for name in names[rep%4:]+names[:rep%4]:
   start=time.perf_counter_ns();db.execute('BEGIN')
   changed=0
   for q,args in writes[name]:changed+=db.execute(q,args).rowcount
   db.rollback()
   if rep>=5:wt[name].append((time.perf_counter_ns()-start)/1e6)
   rowcounts[name]=changed
 assert rowcounts=={'old_title':fan,'new_title':1,'old_close':fan,'new_close_cached':fan+1},rowcounts
 assertions+=1
 out.append({'fanout':fan,'writes':{k:stats(v) for k,v in wt.items()},'changed_rows':rowcounts})
 db.close()
print(json.dumps({'environment':{'python':sys.version.split()[0],'sqlite':sqlite3.sqlite_version,'os':platform.platform()},
 'read_trials':15,'write_trials':40,'assertions':assertions,'results':out,'plans_closed_fan100':plans},indent=2))

PY
