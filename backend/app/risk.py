import re
from dataclasses import dataclass

from .schemas import ListingRequest, Signal


@dataclass
class RiskResult:
    score: int
    signals: list[Signal]


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


def analyze_text(listing: ListingRequest) -> RiskResult:
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

    if len(listing.description.strip()) < 35:
        points += 4
        signals.append(Signal(
            code="sparse_description",
            title="Very little listing detail",
            detail="There is limited description to check. Ask for the full address, viewing details, lease terms, and the identity of the person authorized to rent the unit.",
            severity="low",
        ))

    if not listing.image_urls:
        points += 2
        signals.append(Signal(
            code="no_listing_images",
            title="No listing photos were available to review",
            detail="The page did not provide usable listing photos, so image reuse and image-to-description checks were unavailable.",
            severity="low",
        ))

    return RiskResult(score=min(100, points), signals=signals)


def add_signal(result: RiskResult, signal: Signal, points: int) -> None:
    if any(existing.code == signal.code for existing in result.signals):
        return
    result.signals.append(signal)
    result.score = min(100, result.score + points)


def summarize(score: int) -> tuple[str, str]:
    if score >= 60:
        return "Higher signal", "Several warning signs need careful verification before you proceed."
    if score >= 30:
        return "Review signals", "Some details deserve a closer check before you reply or pay."
    return "Lower signal", "Few automated warning signs were found in the available listing details."
