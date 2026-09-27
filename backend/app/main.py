import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .anomaly import is_density_outlier
from .risk import RiskResult, add_signal, analyze_text, classify, summarize
from .schemas import (
    Baseline,
    FurnishFinderResult,
    ListingAnalysis,
    ListingRequest,
    QuickScore,
    QuickScoreBatchRequest,
    QuickScoreBatchResponse,
    RoomAnalysis,
    Signal,
)
from .storage import store
from .vision import embedder


API_KEY = os.getenv("RENTSHIELD_API_KEY", "").strip()
bearer = HTTPBearer(auto_error=False)

FURNITURE_TERMS = {
    "Bed": r"\b(?:beds?|mattresses?)\b",
    "Desk": r"\bdesk\b",
    "Chair": r"\bchairs?\b",
    "Sofa": r"\b(?:sofa|couch|loveseat)\b",
    "Table": r"\b(?:table|dining table)\b",
    "Dresser": r"\bdresser\b",
    "Wardrobe": r"\b(?:wardrobe|closet)\b",
    "Lamp": r"\blamps?\b",
}


def mentioned_furniture(text: str) -> list[str]:
    return [name for name, pattern in FURNITURE_TERMS.items() if re.search(pattern, text, re.I)]


async def authorize(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> None:
    if not API_KEY:
        return
    if credentials is None or credentials.scheme.lower() != "bearer" or credentials.credentials != API_KEY:
        raise HTTPException(status_code=401, detail="A valid API key is required.")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if store.enabled:
        try:
            import asyncio

            await asyncio.to_thread(store.initialize)
        except Exception as exc:
            # Keep text-only checks available if PostGIS is down; do not log listing content.
            print(f"Rental Shield database initialization failed: {type(exc).__name__}")
    yield


app = FastAPI(
    title="RedFlag Rental Safety API",
    version="0.3.0",
    description="Rental listing safety signals and evidence; not a determination of fraud.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost", "http://127.0.0.1"],
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
@app.get("/api/health")
async def health():
    return {"status": "ok", "database_configured": store.enabled, "vision": embedder.status}


@app.post(
    "/api/quick-scores",
    response_model=QuickScoreBatchResponse,
    dependencies=[Depends(authorize)],
)
async def quick_score_listings(batch: QuickScoreBatchRequest):
    results = []
    for item in batch.listings:
        card_listing = ListingRequest(title=item.title, description=item.description)
        # Search cards expose only a short summary. Do not turn missing fields
        # into the same fixed 4-point “risk” score for every otherwise ordinary ad.
        # The card score covers explicit text warnings only; the listing page
        # performs the fuller completeness and photo checks.
        result = analyze_text(card_listing, include_completeness_signals=False)
        results.append(QuickScore(
            id=item.id,
            risk_score=result.score,
            risk_level=classify(result.score),
            signals=result.signals,
        ))
    return QuickScoreBatchResponse(results=results)


@app.post("/api/analyze", response_model=ListingAnalysis, dependencies=[Depends(authorize)])
async def analyze_listing(listing: ListingRequest):
    import asyncio

    result: RiskResult = analyze_text(listing)
    room_results = []
    for room in listing.rooms:
        room_listing = listing.model_copy(update={
            "title": f"{listing.title} — {room.name}"[:300],
            "description": room.description or listing.description,
            "price": room.price if room.price is not None else listing.price,
            "bedrooms": room.bedrooms if room.bedrooms is not None else listing.bedrooms,
            "bathrooms": room.bathrooms if room.bathrooms is not None else listing.bathrooms,
            "rooms": [],
        })
        room_risk = analyze_text(room_listing)
        room_results.append(RoomAnalysis(
            name=room.name,
            risk_score=room_risk.score,
            risk_level=classify(room_risk.score),
            signals=room_risk.signals,
        ))

    image_urls = [str(url) for url in listing.image_urls]
    vision = await embedder.analyze(listing.title, listing.description, image_urls)

    baseline = Baseline(
        available=False,
        peer_count=0,
        message="No PostGIS history is configured. Price and image reuse comparisons use only history stored by this service.",
    )
    price_comparison_available = False
    if store.enabled:
        exact_duplicate = False
        duplicate_similarity = None
        peers: list[dict] = []
        try:
            exact_duplicate, duplicate_similarity = await asyncio.to_thread(
                store.image_matches, vision.images, listing.source_url
            )
            if listing.latitude is not None and listing.longitude is not None:
                peers = await asyncio.to_thread(
                    store.price_peers, listing.latitude, listing.longitude, listing.currency, listing.price_period,
                    listing.source_url,
                )
                baseline = Baseline(
                    available=len(peers) >= 10,
                    peer_count=len(peers),
                    message=(
                        f"Price check compared with {len(peers)} recent nearby listings captured by this service."
                        if len(peers) >= 10
                        else f"Only {len(peers)} recent nearby listings are available; at least 10 are needed for a density comparison."
                    ),
                )
            else:
                baseline = Baseline(
                    available=False,
                    peer_count=0,
                    message="No coordinates were available on this listing, so neighborhood price comparisons were skipped.",
                )
            await asyncio.to_thread(store.save, listing, vision.images)
        except Exception as exc:
            print(f"Rental Shield history lookup failed: {type(exc).__name__}")
            baseline = Baseline(
                available=False,
                peer_count=0,
                message="Local history could not be reached. Automated neighborhood and image reuse comparisons were skipped.",
            )

        if exact_duplicate or (duplicate_similarity is not None and duplicate_similarity >= 0.985):
            add_signal(result, Signal(
                code="reused_listing_image",
                title="A photo closely matches a previously analyzed listing",
                detail="The service found an exact or very close visual match in its own recent history. Reused photos can have legitimate explanations; check whether the address and unit details match.",
                severity="high",
            ), 23)

        if (
            listing.price is not None
            and listing.latitude is not None
            and listing.longitude is not None
            and len(peers) >= 10
        ):
            price_is_outlier = await asyncio.to_thread(
                is_density_outlier, peers, listing.price, listing.latitude, listing.longitude
            )
            price_comparison_available = True
            if price_is_outlier:
                add_signal(result, Signal(
                    code="local_price_density_outlier",
                    title="Price and location differ from nearby listing patterns",
                    detail="A DBSCAN density check marked this price-and-location combination as unusual among recent listings analyzed by this service. The comparison is a screening signal, not a market valuation.",
                    severity="medium",
                ), 20)
    elif vision.images:
        baseline = Baseline(
            available=False,
            peer_count=0,
            message="Images were processed, but no history database is configured for cross-listing reuse or neighborhood checks.",
        )

    if vision.text_image_similarity is not None and vision.text_image_similarity < 0.16:
        add_signal(result, Signal(
            code="image_text_mismatch",
            title="Photos may not match the listing description",
            detail="The local CLIP model found a weak semantic match between the listing text and its photos. This can happen with short or generic descriptions, so inspect the images and unit yourself.",
            severity="medium",
        ), 12)

    level, summary = summarize(result.score)
    furnishing_available = vision.status == "ready" and any(
        image.get("embedding") is not None for image in vision.images
    )
    mentioned_items = mentioned_furniture(f"{listing.title}\n{listing.description}")
    visible_items = vision.furniture_items if furnishing_available else []
    not_confirmed_items = [item for item in mentioned_items if item not in visible_items]
    if not furnishing_available:
        if vision.status == "not_installed":
            furnishing_summary = "Photo furnishing checks are off because the optional local vision dependencies are not installed."
        elif not vision.images:
            furnishing_summary = "No listing photos could be loaded for a furnishing check."
        else:
            furnishing_summary = "The local photo model could not produce a furnishing estimate."
    elif visible_items and not_confirmed_items:
        furnishing_summary = "Some advertised items were not confirmed in these photos."
    elif visible_items:
        furnishing_summary = "Furniture is likely visible in the listing photos."
    else:
        furnishing_summary = "No furniture was confidently identified in the available photos."
    furnish_finder = FurnishFinderResult(
        available=furnishing_available,
        summary=furnishing_summary,
        likely_visible_items=visible_items,
        mentioned_items=mentioned_items,
        not_confirmed_items=not_confirmed_items if furnishing_available else [],
        note=(
            "Automated photo estimate. A photo may not show every item, and similar objects can be mistaken; confirm furnishings during a viewing."
            if furnishing_available
            else (
                "Install backend/requirements-vision.txt and restart the analysis service to enable local photo estimates."
                if vision.status == "not_installed"
                else "Confirm furnishings with the person offering the unit; the photo estimate was unavailable."
            )
        ),
    )
    return ListingAnalysis(
        risk_score=result.score,
        risk_level=level,
        summary=summary,
        signals=result.signals,
        baseline=baseline,
        vision_status=vision.status,
        photos_processed=len(vision.images),
        photo_text_match_available=vision.text_image_similarity is not None,
        price_comparison_available=price_comparison_available,
        room_results=room_results,
        furnish_finder=furnish_finder,
        analyzed_at=datetime.now(timezone.utc),
    )
