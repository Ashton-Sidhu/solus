#!/usr/bin/env bash
set -euo pipefail
# Run from the Solus repository root. All SQLite databases are in memory.
python3 - <<'PY'
import sqlite3, json, time, statistics
c = sqlite3.connect(':memory:')
c.executescript("""
CREATE TABLE docs(id INTEGER PRIMARY KEY,data TEXT);
CREATE TABLE threads(id INTEGER PRIMARY KEY,data TEXT);
""")
j = lambda v: json.dumps(v, separators=(',', ':'))
for n in (1, 10, 100):
    rows = [dict(id=str(i), comment='x'*1024, selectedText='q'*128,
                 replies=[], readBy=[]) for i in range(n)]
    c.execute('DELETE FROM docs')
    c.execute('DELETE FROM threads')
    c.execute('INSERT INTO docs VALUES(1,?)', (j(rows),))
    c.executemany('INSERT INTO threads VALUES(?,?)',
                  [(i, j(v)) for i, v in enumerate(rows)])

    def measure(whole):
        times = []
        for repeat in range(5):
            start = time.perf_counter_ns()
            for i in range(200):
                rows[0]['comment'] = 'x'*1020 + f'{i:04}'
                payload = j(rows if whole else rows[0])
                table = 'docs' if whole else 'threads'
                c.execute('UPDATE '+table+' SET data=? WHERE id=?',
                          (payload, 1 if whole else 0))
            times.append((time.perf_counter_ns()-start)/200/1000)
        return round(statistics.median(times), 2)

    print(n, 'threads; changing-edit serialization+SQL us:',
          measure(True), measure(False), 'bytes:',
          len(j(rows).encode()), len(j(rows[0]).encode()))
    print('resolve-all logical payloads:',
          len(j(rows).encode()), sum(len(j(v).encode()) for v in rows),
          'rows changed:', 1, n)
PY
