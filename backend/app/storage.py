"""Optional PostgreSQL/PostGIS persistence for private, local history."""

import json
import hashlib
import os
from typing import Any

import numpy as np
import psycopg
from psycopg.rows import dict_row


SCHEMA = """
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS analyzed_listings (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    price DOUBLE PRECISION,
    currency CHAR(3) NOT NULL,
    price_period TEXT NOT NULL,
    location GEOGRAPHY(POINT, 4326),
    source_fingerprint CHAR(64)
);
ALTER TABLE analyzed_listings ADD COLUMN IF NOT EXISTS source_fingerprint CHAR(64);
CREATE INDEX IF NOT EXISTS analyzed_listings_created_idx ON analyzed_listings (created_at DESC);
CREATE INDEX IF NOT EXISTS analyzed_listings_location_idx ON analyzed_listings USING GIST (location);
CREATE UNIQUE INDEX IF NOT EXISTS analyzed_listings_source_idx ON analyzed_listings (source_fingerprint) WHERE source_fingerprint IS NOT NULL;
CREATE TABLE IF NOT EXISTS analyzed_images (
    id BIGSERIAL PRIMARY KEY,
    listing_id BIGINT NOT NULL REFERENCES analyzed_listings(id) ON DELETE CASCADE,
    sha256 CHAR(64) NOT NULL,
    average_hash CHAR(16) NOT NULL,
    embedding JSONB
);
CREATE INDEX IF NOT EXISTS analyzed_images_hash_idx ON analyzed_images (sha256);
CREATE INDEX IF NOT EXISTS analyzed_images_listing_idx ON analyzed_images (listing_id);
"""


class ListingStore:
    def __init__(self) -> None:
        self.dsn = os.getenv("RENTSHIELD_DATABASE_URL", "").strip()

    @property
    def enabled(self) -> bool:
        return bool(self.dsn)

    def connect(self):
        if not self.enabled:
            raise RuntimeError("Database is not configured")
        return psycopg.connect(self.dsn, row_factory=dict_row, connect_timeout=4)

    def initialize(self) -> None:
        if not self.enabled:
            return
        with self.connect() as connection:
            connection.execute(SCHEMA)

    def price_peers(self, latitude: float, longitude: float, currency: str, period: str, source_url=None) -> list[dict[str, Any]]:
        fingerprint = self._fingerprint(source_url)
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT price,
                       ST_Y(location::geometry) AS latitude,
                       ST_X(location::geometry) AS longitude
                FROM analyzed_listings
                WHERE created_at > now() - interval '90 days'
                  AND currency = %s AND price_period = %s AND price IS NOT NULL
                  AND location IS NOT NULL
                  AND (%s IS NULL OR source_fingerprint IS DISTINCT FROM %s)
                  AND ST_DWithin(location, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, 3000)
                ORDER BY created_at DESC
                LIMIT 300
                """,
                (currency, period, fingerprint, fingerprint, longitude, latitude),
            ).fetchall()
        return [dict(row) for row in rows]

    @staticmethod
    def _fingerprint(source_url) -> str | None:
        if not source_url:
            return None
        return hashlib.sha256(str(source_url).encode("utf-8")).hexdigest()

    def image_matches(self, images: list[dict], source_url=None) -> tuple[bool, float | None]:
        if not images:
            return False, None
        fingerprint = self._fingerprint(source_url)
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT image.sha256, image.average_hash, image.embedding
                FROM analyzed_images AS image
                JOIN analyzed_listings AS listing ON listing.id = image.listing_id
                WHERE listing.source_fingerprint IS DISTINCT FROM %s
                  AND listing.id IN (
                    SELECT id FROM analyzed_listings
                    WHERE created_at > now() - interval '180 days'
                    ORDER BY created_at DESC LIMIT 2000
                )
                """,
                (fingerprint,),
            ).fetchall()
        exact = False
        best = 0.0
        prior_embeddings: list[np.ndarray] = []
        prior_hashes: set[str] = set()
        prior_average_hashes: list[int] = []
        for row in rows:
            prior_hashes.add(row["sha256"].strip())
            try:
                prior_average_hashes.append(int(row["average_hash"].strip(), 16))
            except (TypeError, ValueError):
                pass
            if row["embedding"]:
                try:
                    vector = np.asarray(row["embedding"], dtype=np.float32)
                    if vector.ndim == 1 and vector.size:
                        prior_embeddings.append(vector)
                except (TypeError, ValueError):
                    continue
        for image in images:
            exact = exact or image["sha256"] in prior_hashes
            try:
                image_hash = int(image["average_hash"], 16)
                exact = exact or any((image_hash ^ prior_hash).bit_count() <= 4 for prior_hash in prior_average_hashes)
            except (TypeError, ValueError, KeyError):
                pass
            raw = image.get("embedding")
            if raw is None:
                continue
            vector = np.asarray(raw, dtype=np.float32)
            for prior in prior_embeddings:
                if prior.shape == vector.shape:
                    best = max(best, float(np.dot(vector, prior)))
        return exact, best if best > 0 else None

    def save(self, listing, images: list[dict]) -> None:
        fingerprint = self._fingerprint(listing.source_url)
        with self.connect() as connection:
            row = connection.execute(
                """
                INSERT INTO analyzed_listings (price, currency, price_period, location, source_fingerprint)
                VALUES (%s, %s, %s,
                    CASE WHEN %s IS NULL OR %s IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography END,
                    %s)
                ON CONFLICT (source_fingerprint) WHERE source_fingerprint IS NOT NULL
                DO UPDATE SET created_at = now(), price = EXCLUDED.price,
                    currency = EXCLUDED.currency, price_period = EXCLUDED.price_period,
                    location = EXCLUDED.location
                RETURNING id
                """,
                (
                    listing.price, listing.currency, listing.price_period,
                    listing.latitude, listing.longitude, listing.longitude, listing.latitude, fingerprint,
                ),
            ).fetchone()
            connection.execute("DELETE FROM analyzed_images WHERE listing_id = %s", (row["id"],))
            for image in images:
                connection.execute(
                    """
                    INSERT INTO analyzed_images (listing_id, sha256, average_hash, embedding)
                    VALUES (%s, %s, %s, %s::jsonb)
                    """,
                    (
                        row["id"], image["sha256"], image["average_hash"],
                        json.dumps(image["embedding"]) if image.get("embedding") is not None else None,
                    ),
                )


store = ListingStore()
