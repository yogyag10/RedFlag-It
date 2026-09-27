from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator


class RoomRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=12_000)
    price: float | None = Field(default=None, gt=0, le=1_000_000)
    bedrooms: float | None = Field(default=None, ge=0, le=100)
    bathrooms: float | None = Field(default=None, ge=0, le=100)


class ListingRequest(BaseModel):
    title: str = Field(default="", max_length=300)
    description: str = Field(default="", max_length=12_000)
    bedrooms: float | None = Field(default=None, ge=0, le=100)
    bathrooms: float | None = Field(default=None, ge=0, le=100)
    address: str | None = Field(default=None, max_length=500)
    price: float | None = Field(default=None, gt=0, le=1_000_000)
    currency: str = Field(default="CAD", min_length=3, max_length=3)
    price_period: Literal["month", "week", "day", "night", "unknown"] = "month"
    location_text: str = Field(default="", max_length=300)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    image_urls: list[HttpUrl] = Field(default_factory=list, max_length=8)
    source_url: HttpUrl | None = None
    rooms: list[RoomRequest] = Field(default_factory=list, max_length=6)
    profile_facts: list[Annotated[str, Field(max_length=200)]] = Field(default_factory=list, max_length=6)
    listing_age: str | None = Field(default=None, max_length=100)
    availability_text: str | None = Field(default=None, max_length=200)

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str) -> str:
        return value.upper()


class QuickListingRequest(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    title: str = Field(default="", max_length=300)
    description: str = Field(default="", max_length=1_200)
    photo_available: bool = False


class QuickScoreBatchRequest(BaseModel):
    listings: list[QuickListingRequest] = Field(min_length=1, max_length=20)


class Signal(BaseModel):
    code: str
    title: str
    detail: str
    severity: Literal["low", "medium", "high"]
    evidence: str | None = None
    evidence_source: Literal["title", "description"] | None = None


class QuickScore(BaseModel):
    id: str
    risk_score: int = Field(ge=0, le=100)
    risk_level: Literal["LOW RISK", "BE CAREFUL", "SCAM POSSIBLE"]
    signals: list[Signal]


class QuickScoreBatchResponse(BaseModel):
    results: list[QuickScore]


class Baseline(BaseModel):
    available: bool
    peer_count: int = 0
    message: str


class VoteCounts(BaseModel):
    fake: int = Field(ge=0, le=6)
    real: int = Field(ge=0, le=6)
    unknown: int = Field(default=0, ge=0, le=6)


class RiskLight(BaseModel):
    """Traffic-light summary of the vote: green = no warning signs, yellow = one,
    red = two or more. A low price counts only alongside another warning sign."""
    color: Literal["green", "yellow", "red"]
    warnings: int = Field(ge=0, le=6)
    label: str


class VoteSummary(BaseModel):
    fake: bool
    votes: VoteCounts
    risk_light: RiskLight
    review_check_available: bool
    consensus_rules: list[str] = Field(default_factory=list)
    # One "vote | code | rule" string per tree of the fraud model (5), or per
    # rule check (6) when the model is unavailable.
    trees: list[str] = Field(min_length=1, max_length=6)


class RoomAnalysis(VoteSummary):
    name: str
    risk_score: int = Field(ge=0, le=100)
    risk_level: Literal["LOW RISK", "BE CAREFUL", "SCAM POSSIBLE"]
    signals: list[Signal]


class FurnishFinderResult(BaseModel):
    available: bool
    summary: str
    likely_visible_items: list[str] = Field(default_factory=list)
    mentioned_items: list[str] = Field(default_factory=list)
    not_confirmed_items: list[str] = Field(default_factory=list)
    note: str


class ListingAnalysis(VoteSummary):
    risk_score: int = Field(ge=0, le=100)
    risk_level: Literal["LOW RISK", "BE CAREFUL", "SCAM POSSIBLE"]
    summary: str
    signals: list[Signal]
    baseline: Baseline
    vision_status: str
    photo_urls_received: int = 0
    photos_processed: int = 0
    photo_text_match_available: bool = False
    price_comparison_available: bool = False
    room_results: list[RoomAnalysis] = Field(default_factory=list)
    furnish_finder: FurnishFinderResult
    analyzed_at: datetime
