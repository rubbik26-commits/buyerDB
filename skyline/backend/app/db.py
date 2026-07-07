import os
import threading
from contextlib import contextmanager
from psycopg2.pool import ThreadedConnectionPool
import psycopg2.extras

_pool = None
_pool_lock = threading.Lock()


def pool():
    global _pool
    if _pool is None:
        with _pool_lock:  # two first-requests used to construct two pools (one leaked)
            if _pool is None:
                # FastAPI's sync threadpool runs ~40 workers; getconn() raises
                # immediately (does not block) when the pool is empty, so the
                # max must cover realistic concurrency.
                _pool = ThreadedConnectionPool(
                    1, int(os.environ.get("DB_POOL_MAX", "40")),
                    os.environ.get("DATABASE_URL",
                                   "postgresql://skyline:skyline_dev@localhost/skyline"))
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
        # a server-side disconnect poisons the conn; returning it as-is would
        # fail the next request that draws it
        pool().putconn(conn, close=conn.closed)


def rows(cur):
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]
