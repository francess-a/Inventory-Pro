"""Database connection helpers."""
import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

DEFAULT_URL = "postgresql://inv:inv@localhost:5432/inventory"


def database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_URL)


def connect(url: str | None = None) -> psycopg.Connection:
    return psycopg.connect(url or database_url(), row_factory=dict_row)


def init_schema(conn: psycopg.Connection) -> None:
    """Create tables and default settings. Safe to run repeatedly."""
    conn.execute(Path(__file__).with_name("schema.sql").read_text())
    conn.commit()


if __name__ == "__main__":
    with connect() as c:
        init_schema(c)
    print("Schema ready.")
