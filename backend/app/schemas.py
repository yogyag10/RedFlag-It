from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator


class ListingRequest(BaseModel):
    title: str = Field(default="", max_length=300)
    description: str = Field(default="", max_length=12_000)
    price: float | None = Field(default=None, gt=0, le=1_000_000)
    currency: str = Field(default="CAD", min_length=3, max_length=3)
    price_period: Literal["month", "week", "day", "night", "unknown"] = "month"
    location_text: str = Field(default="", max_length=300)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    image_urls: list[HttpUrl] = Field(default_factory=list, max_length=8)
    source_url: HttpUrl | None = None

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str) -> str:
        return value.upper()


class Signal(BaseModel):
    code: str
    title: str
    detail: str
    severity: Literal["low", "medium", "high"]
    evidence: str | None = None
    evidence_source: Literal["title", "description"] | None = None


class Baseline(BaseModel):
    available: bool
    peer_count: int = 0
    message: str


class ListingAnalysis(BaseModel):
    risk_score: int = Field(ge=0, le=100)
    risk_level: Literal["Lower signal", "Review signals", "Higher signal"]
    summary: str
    signals: list[Signal]
    baseline: Baseline
    vision_status: str
    photos_processed: int = 0
    photo_text_match_available: bool = False
    price_comparison_available: bool = False
    analyzed_at: datetime
