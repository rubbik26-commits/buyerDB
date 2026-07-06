import os
from contextlib import contextmanager
from psycopg2.pool import ThreadedConnectionPool
import psycopg2.extras

_pool = None

def pool():
    global _pool
    if _pool is None:
        _pool = ThreadedConnectionPool(1, 8, os.environ.get(
            "DATABASE_URL", "postgresql://skyline:skyline_dev@localhost/skyline"))
    return _pool

@contextmanager
def db():
    conn = pool().getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool().putconn(conn)

def rows(cur):
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]
