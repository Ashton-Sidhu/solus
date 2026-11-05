#!/usr/bin/env bash
set -euo pipefail
# Run from the Solus repository root. All SQLite databases are in memory.
python3 - <<'PY'
import sqlite3
url = 'file:thread-order-audit?mode=memory&cache=shared'
a = sqlite3.connect(url, uri=True, isolation_level=None)
b = sqlite3.connect(url, uri=True, isolation_level=None)
a.executescript("""
CREATE TABLE parent(id TEXT PRIMARY KEY,next_position INTEGER NOT NULL);
INSERT INTO parent VALUES('p',0);
CREATE TABLE threads(id TEXT PRIMARY KEY,position INTEGER);
""")
a.execute('BEGIN IMMEDIATE')
p = a.execute("""
UPDATE parent SET next_position=next_position+1
WHERE id='p' RETURNING next_position
""").fetchone()[0]
a.execute("INSERT INTO threads VALUES('first',?)", (p,))
locked = False
try:
    b.execute('BEGIN IMMEDIATE')
except sqlite3.OperationalError as e:
    locked = 'locked' in str(e)
assert locked
assert p == 1
a.execute('COMMIT')
b.execute('BEGIN IMMEDIATE')
p = b.execute("""
UPDATE parent SET next_position=next_position+1
WHERE id='p' RETURNING next_position
""").fetchone()[0]
b.execute("INSERT INTO threads VALUES('second',?)", (p,))
b.execute('COMMIT')
assert list(a.execute('SELECT id,position FROM threads ORDER BY position')) == [
    ('first', 1), ('second', 2)]
print('PASSED 3 FAILED 0')
a.close()
b.close()
PY
