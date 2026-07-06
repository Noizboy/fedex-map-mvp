from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .parsing import (
    build_address,
    clean_text,
    coerce_stop_payload,
    normalize_house_number,
    normalize_instance_config,
    normalize_key,
    normalize_street_name,
    parse_address_text,
)


@dataclass
class StopRepository:
    db_path: str

    def __post_init__(self) -> None:
        path = Path(self.db_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _create_stops_table(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS stops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instance_id INTEGER NOT NULL,
                raw_text TEXT NOT NULL,
                house_number TEXT NOT NULL,
                street_name TEXT NOT NULL,
                normalized_key TEXT NOT NULL,
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                source TEXT NOT NULL DEFAULT 'json',
                created_at TEXT NOT NULL,
                FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_stops_instance_normalized_key
            ON stops(instance_id, normalized_key)
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_stops_instance_id ON stops(instance_id)"
        )

    def _ensure_default_instance(self, conn: sqlite3.Connection) -> int:
        created_at = datetime.now(timezone.utc).isoformat()
        conn.execute(
            """
            INSERT OR IGNORE INTO instances (name, slug, config_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            ("Default Instance", "default", json.dumps(normalize_instance_config(None)), created_at),
        )
        row = conn.execute(
            "SELECT id FROM instances WHERE slug = ?",
            ("default",),
        ).fetchone()
        return int(row["id"])

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS instances (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    slug TEXT NOT NULL UNIQUE,
                    config_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )

            table_exists = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stops'"
            ).fetchone()

            if not table_exists:
                self._create_stops_table(conn)
                conn.commit()
                return

            columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(stops)").fetchall()
            }
            if "instance_id" not in columns:
                default_instance_id = self._ensure_default_instance(conn)
                conn.execute("ALTER TABLE stops RENAME TO stops_legacy")
                self._create_stops_table(conn)
                conn.execute(
                    """
                    INSERT INTO stops (
                        id, instance_id, raw_text, house_number, street_name,
                        normalized_key, lat, lng, source, created_at
                    )
                    SELECT
                        id, ?, raw_text, house_number, street_name,
                        normalized_key, lat, lng, source, created_at
                    FROM stops_legacy
                    """,
                    (default_instance_id,),
                )
                conn.execute("DROP TABLE stops_legacy")
            else:
                self._create_stops_table(conn)

            conn.commit()

    def _row_to_instance(self, row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        config_json = row["config_json"] or "{}"
        return {
            "id": int(row["id"]),
            "name": row["name"],
            "slug": row["slug"],
            "config": json.loads(config_json),
            "created_at": row["created_at"],
        }

    def list_instances(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM instances ORDER BY id ASC").fetchall()
        return [self._row_to_instance(row) for row in rows if row is not None]

    def get_instance(self, instance_id: int) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM instances WHERE id = ?", (instance_id,)).fetchone()
        return self._row_to_instance(row)

    def get_instance_by_slug(self, slug: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM instances WHERE slug = ?", (slug,)).fetchone()
        return self._row_to_instance(row)

    def _slugify(self, value: str) -> str:
        cleaned = clean_text(value).lower()
        slug = re.sub(r"[^a-z0-9]+", "-", cleaned).strip("-")
        return slug

    def _build_unique_slug(self, conn: sqlite3.Connection, name: str, slug: str | None) -> str:
        base_slug = self._slugify(slug or name)
        if not base_slug:
            raise ValueError("Instance slug is required")

        candidate = base_slug
        suffix = 2
        while conn.execute(
            "SELECT 1 FROM instances WHERE slug = ?",
            (candidate,),
        ).fetchone():
            candidate = f"{base_slug}-{suffix}"
            suffix += 1
        return candidate

    def create_instance(
        self,
        name: str,
        slug: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        normalized_name = clean_text(name)
        if not normalized_name:
            raise ValueError("Instance name is required")

        normalized_config = normalize_instance_config(config)
        created_at = datetime.now(timezone.utc).isoformat()

        with self._connect() as conn:
            resolved_slug = self._build_unique_slug(conn, normalized_name, slug)
            conn.execute(
                """
                INSERT INTO instances (name, slug, config_json, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (normalized_name, resolved_slug, json.dumps(normalized_config), created_at),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM instances WHERE slug = ?",
                (resolved_slug,),
            ).fetchone()

        instance = self._row_to_instance(row)
        assert instance is not None
        return instance

    def list_stops(self, instance_id: int) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM stops WHERE instance_id = ? ORDER BY id ASC",
                (instance_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def clear_stops(self, instance_id: int) -> int:
        with self._connect() as conn:
            deleted = conn.execute(
                "SELECT COUNT(*) FROM stops WHERE instance_id = ?",
                (instance_id,),
            ).fetchone()[0]
            conn.execute("DELETE FROM stops WHERE instance_id = ?", (instance_id,))
            conn.commit()
        return int(deleted)

    def delete_stop(self, instance_id: int, stop_id: int) -> bool:
        with self._connect() as conn:
            deleted = conn.execute(
                "DELETE FROM stops WHERE id = ? AND instance_id = ?",
                (stop_id, instance_id),
            ).rowcount
            conn.commit()
        return deleted > 0

    def add_stop(
        self,
        instance_id: int,
        payload: dict[str, Any],
        geocoder,
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        stop_payload = coerce_stop_payload(payload, config)
        raw_text = str(stop_payload.get("text") or stop_payload.get("raw_text") or "").strip()
        house_number = stop_payload.get("house_number")
        street_name = stop_payload.get("street_name")

        if house_number and street_name:
            display_house_number = clean_text(str(house_number))
            display_street_name = clean_text(str(street_name))
            key_house_number = normalize_house_number(house_number)
            key_street_name = normalize_street_name(street_name)
        elif raw_text:
            parsed_house, parsed_street = parse_address_text(raw_text)
            display_house_number = clean_text(parsed_house)
            display_street_name = clean_text(parsed_street)
            key_house_number = normalize_house_number(parsed_house)
            key_street_name = normalize_street_name(parsed_street)
        else:
            raise ValueError("You must send text or house_number + street_name")

        normalized = normalize_key(key_house_number, key_street_name)
        address = build_address(display_house_number, display_street_name)

        lat = stop_payload.get("lat")
        lng = stop_payload.get("lng")
        if lat is None or lng is None:
            lat, lng = geocoder.geocode(address)

        source = str(stop_payload.get("source") or "json")
        created_at = datetime.now(timezone.utc).isoformat()

        record = {
            "instance_id": instance_id,
            "raw_text": raw_text or address,
            "house_number": display_house_number,
            "street_name": display_street_name,
            "normalized_key": normalized,
            "lat": float(lat),
            "lng": float(lng),
            "source": source,
            "created_at": created_at,
        }

        with self._connect() as conn:
            existing = conn.execute(
                "SELECT * FROM stops WHERE instance_id = ? AND normalized_key = ?",
                (instance_id, normalized),
            ).fetchone()
            if existing:
                return {"created": False, "stop": dict(existing)}

            conn.execute(
                """
                INSERT INTO stops (
                    instance_id, raw_text, house_number, street_name, normalized_key,
                    lat, lng, source, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["instance_id"],
                    record["raw_text"],
                    record["house_number"],
                    record["street_name"],
                    record["normalized_key"],
                    record["lat"],
                    record["lng"],
                    record["source"],
                    record["created_at"],
                ),
            )
            conn.commit()
            inserted = conn.execute(
                "SELECT * FROM stops WHERE instance_id = ? AND normalized_key = ?",
                (instance_id, normalized),
            ).fetchone()

        return {"created": True, "stop": dict(inserted)}

    def bulk_add(
        self,
        instance_id: int,
        records: list[dict[str, Any]],
        geocoder,
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        results = []
        created = 0
        duplicates = 0
        for payload in records:
            result = self.add_stop(instance_id, payload, geocoder, config)
            results.append(result)
            if result["created"]:
                created += 1
            else:
                duplicates += 1
        return {"created": created, "duplicates": duplicates, "results": results}
