import re
from dataclasses import dataclass

from .schemas import ListingRequest, Signal


@dataclass
class RiskResult:
    score: int
    signals: list[Signal]
    review_summary: tuple[float, int] | None = None


def _matched_evidence(pattern: re.Pattern[str], listing: ListingRequest) -> tuple[str | None, str | None]:
    for source, value in (("title", listing.title), ("description", listing.description)):
        match = pattern.search(value)
        if not match:
            continue
        evidence = match.group(0)
        evidence = re.sub(r"https?://\S+|www\.\S+", "[link removed]", evidence, flags=re.I)
        evidence = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b", "[email removed]", evidence, flags=re.I)
        evidence = re.sub(r"(?<!\w)\+?\d[\d\s().-]{7,}\d(?!\w)", "[number removed]", evidence)
        evidence = " ".join(evidence.split())[:140]
        return evidence, source
    return None, None


RULES: list[tuple[str, re.Pattern[str], str, str, int]] = [
    (
        "payment_before_viewing",
        re.compile(r"\b(?:deposit|rent|payment|transfer|fee)\b.{0,90}\b(?:before|prior to)\b.{0,40}\b(?:view|viewing|see|tour|visit)\b|\b(?:before|prior to)\b.{0,40}\b(?:view|viewing|see|tour)\b.{0,90}\b(?:deposit|rent|payment|transfer)\b", re.I),
        "Payment requested before a viewing",
        "The listing text appears to ask for money before you can see the unit. Verify the property and arrange an in-person or live video viewing before paying.",
        28,
    ),
    (
        "wire_or_irreversible_payment",
        re.compile(r"\b(?:wire transfer|western union|moneygram|gift cards?|crypto(?:currency)?|bitcoin|e-?transfer only)\b", re.I),
        "Unusual or hard-to-reverse payment method",
        "The listing mentions a payment method that can be difficult to reverse. Verify the unit and recipient, and agree on a traceable payment process before paying.",
        24,
    ),
    (
        "landlord_unavailable",
        re.compile(r"\b(?:out of (?:the )?country|overseas|cannot meet|can't meet|unable to meet|keys? (?:will be|are) shipped|ship(?:ping)? the keys)\b", re.I),
        "Landlord may not be available to show the unit",
        "The text suggests the person offering the unit cannot meet or is arranging key delivery. Independently verify their authority to rent it.",
        22,
    ),
    (
        "verification_code",
        re.compile(r"\b(?:send|share|tell me|text me)\b.{0,45}\b(?:verification|login|security|6[- ]?digit)\s+code\b|\bcode\b.{0,45}\b(?:facebook|google|account)\b", re.I),
        "Request for an account verification code",
        "Never share a sign-in or verification code with a prospective landlord. A legitimate rental screening does not need access to your account.",
        30,
    ),
    (
        "pressure_tactic",
        re.compile(r"\b(?:act now|first come first served|many people interested|send deposit today|urgent(?:ly)?|won't last|must decide immediately)\b", re.I),
        "Urgent pressure in the listing text",
        "Pressure to decide or send money quickly can make independent checks harder. Take time to verify the unit and the person offering it.",
        10,
    ),
]


def parse_review_summary(profile_facts: list[str]) -> tuple[float, int] | None:
    for fact in profile_facts:
        count_match = re.search(
            r"\(\s*(\d+)\s*(?:reviews?|ratings?)?\s*\)|\b(\d+)\s+(?:reviews?|ratings?)\b",
            fact,
            re.I,
        )
        if not count_match:
            continue
        count = int(count_match.group(1) or count_match.group(2))
        rating_match = re.search(
            r"(?<![\d.])([0-5](?:\.\d+)?)\s*(?:/\s*5|out\s+of\s+5|stars?\b|[\u2605\u2b50])",
            fact,
            re.I,
        )
        if not rating_match and re.search(r"\b(?:(?:seller|public)\s+)?(?:ratings?|reviews?)\b", fact, re.I):
            rating_match = re.search(r"(?<![\d.])([0-5]\.\d+)(?![\d.])", fact)
        if rating_match:
            rating = float(rating_match.group(1))
        else:
            star_match = re.search(r"((?:[\u2605\u2606\u2b50]\ufe0f?){1,5})", fact)
            if not star_match:
                continue
            rating = float(sum(star in ("\u2605", "\u2b50") for star in star_match.group(1)))
        if 0 <= rating <= 5:
            return rating, count
    return None


def analyze_text(
    listing: ListingRequest,
    *,
    photos_available: bool | None = None,
    include_completeness_signals: bool = True,
) -> RiskResult:
    text = f"{listing.title}\n{listing.description}"
    points = 0
    signals: list[Signal] = []
    for code, pattern, title, detail, weight in RULES:
        if pattern.search(text):
            points += weight
            severity = "high" if weight >= 22 else "medium"
            evidence, evidence_source = _matched_evidence(pattern, listing)
            signals.append(Signal(
                code=code,
                title=title,
                detail=detail,
                severity=severity,
                evidence=evidence,
                evidence_source=evidence_source,
            ))

    review_summary = parse_review_summary(listing.profile_facts)
    if review_summary is not None:
        rating, review_count = review_summary
        if review_count >= 5 and rating <= 2.5:
            points += 12
            signals.append(Signal(
                code="low_public_review_rating",
                title="Low public review rating",
                detail=(
                    f"The visible seller rating is {rating:.1f}/5 across {review_count} reviews. "
                    "Read the reviews and verify the person independently; a rating alone cannot confirm a rental."
                ),
                severity="medium",
            ))

    if include_completeness_signals and len(listing.description.strip()) < 35:
        points += 4
        signals.append(Signal(
            code="sparse_description",
            title="Very little listing detail",
            detail="There is limited description to check. Ask for the full address, viewing details, lease terms, and the identity of the person authorized to rent the unit.",
            severity="low",
        ))

    if include_completeness_signals and not (photos_available if photos_available is not None else bool(listing.image_urls)):
        points += 2
        signals.append(Signal(
            code="no_listing_images",
            title="No listing photos were available to review",
            detail="The page did not provide usable listing photos, so image reuse and image-to-description checks were unavailable.",
            severity="low",
        ))

    return RiskResult(score=min(100, points), signals=signals, review_summary=review_summary)


def add_signal(result: RiskResult, signal: Signal, points: int) -> None:
    if any(existing.code == signal.code for existing in result.signals):
        return
    result.signals.append(signal)
    result.score = min(100, result.score + points)


def vote_summary(result: RiskResult) -> dict[str, object]:
    """Return five warning-rule votes and one public-review check."""
    matched_codes = {signal.code for signal in result.signals}
    fake_votes = 0
    real_votes = 0
    unknown_votes = 0
    consensus_rules: list[str] = []
    trees: list[str] = []

    for code, _pattern, title, _detail, _weight in RULES:
        matched = code in matched_codes
        vote = "fake" if matched else "real"
        if matched:
            fake_votes += 1
            consensus_rules.append(title)
            rule = title
        else:
            real_votes += 1
            rule = f"{title} rule not detected"
        trees.append(f"{vote} | {code} | {rule}")

    review_match = "low_public_review_rating" in matched_codes
    if review_match:
        review_vote = "fake"
        rating, review_count = result.review_summary or (0, 0)
        review_rule = f"Low public rating {rating:.1f}/5 from {review_count} reviews"
        consensus_rules.append(review_rule)
        fake_votes += 1
    elif result.review_summary is None or result.review_summary[1] < 5:
        review_vote = "unknown"
        unknown_votes += 1
        if result.review_summary is None:
            review_rule = "No public review summary was visible; review check unavailable"
        else:
            review_rule = f"Only {result.review_summary[1]} public reviews visible; too few to assess"
    else:
        review_vote = "real"
        real_votes += 1
        rating, review_count = result.review_summary
        review_rule = f"No low-rating warning; public rating {rating:.1f}/5 from {review_count} reviews"
    trees.append(f"{review_vote} | review_checker | {review_rule}")

    return {
        "fake": fake_votes > real_votes,
        "votes": {"fake": fake_votes, "real": real_votes, "unknown": unknown_votes},
        "review_check_available": result.review_summary is not None and result.review_summary[1] >= 5,
        "consensus_rules": consensus_rules,
        "trees": trees,
    }


def classify(score: int) -> str:
    if score >= 60:
        return "SCAM POSSIBLE"
    if score >= 30:
        return "BE CAREFUL"
    return "LOW RISK"


def summarize(score: int) -> tuple[str, str]:
    level = classify(score)
    summary = {
        "LOW RISK": "Few common warning signs were found.",
        "BE CAREFUL": "Some details deserve a closer look.",
        "SCAM POSSIBLE": "Several warning signs need careful verification.",
    }[level]
    return level, summary
