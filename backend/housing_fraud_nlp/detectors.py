"""Rule-based detectors for textual rental-fraud warning signs.

Each public ``detect_*`` function is independent: it takes listing text, parses
it with spaCy (parses are cached, so calling several detectors on the same text
is cheap) and returns a ``DetectionResult`` whose evidence is the list of
sentences that triggered it.

The detectors work sentence by sentence and combine three kinds of evidence:
``Matcher``/``PhraseMatcher`` hits for the vocabulary in ``patterns.py``,
part-of-speech and dependency structure to tell a request apart from a
description, and named entities for places.
"""

from dataclasses import dataclass, field
from functools import lru_cache

from spacy.matcher import Matcher, PhraseMatcher
from spacy.tokens import Span, Token

from . import patterns as P
from .nlp import get_nlp, parse


@dataclass(frozen=True)
class DetectionResult:
    detected: bool
    evidence: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"detected": self.detected, "evidence": list(self.evidence)}


# ---------------------------------------------------------------------------
# Matchers
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _matchers() -> dict:
    nlp = get_nlp()

    def token_matcher(token_patterns: list) -> Matcher:
        matcher = Matcher(nlp.vocab)
        matcher.add("PATTERN", token_patterns)
        return matcher

    def phrase_matcher(phrases: list[str], attr: str) -> PhraseMatcher:
        matcher = PhraseMatcher(nlp.vocab, attr=attr)
        matcher.add("PHRASE", [nlp.make_doc(phrase) for phrase in phrases])
        return matcher

    return {
        "deposit": token_matcher(P.DEPOSIT_TERM_PATTERNS),
        "urgency": token_matcher(P.URGENCY_PATTERNS),
        "first_to_pay": token_matcher(P.FIRST_TO_PAY_PATTERNS),
        "lease_signing": token_matcher(P.LEASE_SIGNING_PATTERNS),
        "sensitive_info": token_matcher(P.SENSITIVE_INFO_PATTERNS),
        "etransfer": token_matcher(P.ETRANSFER_PATTERNS),
        "demand": token_matcher(P.DEMAND_PATTERNS),
        "people_demand": token_matcher(P.PEOPLE_DEMAND_PATTERNS),
        "scarcity": token_matcher(P.SCARCITY_PATTERNS),
        "abroad": token_matcher(P.ABROAD_PATTERNS),
        "money_service": token_matcher(P.MONEY_SERVICE_PATTERNS),
        "foreign_places": phrase_matcher(P.FOREIGN_PLACES, "LOWER"),
        "foreign_acronyms": phrase_matcher(P.FOREIGN_ACRONYMS, "ORTH"),
    }


def _find(name: str, sent: Span) -> list[Span]:
    return list(_matchers()[name](sent, as_spans=True))


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _sentences(text) -> list[Span]:
    if text is None:
        return []
    if not isinstance(text, str):
        raise TypeError(f"text must be a str, not {type(text).__name__}")
    if not text.strip():
        return []
    return list(parse(text).sents)


def _result(evidence: list[str]) -> DetectionResult:
    unique = list(dict.fromkeys(evidence))
    return DetectionResult(detected=bool(unique), evidence=unique)


def _lemma(token: Token) -> str:
    return token.lemma_.lower()


def _first_content_token(sent: Span) -> Token | None:
    """First token that could start an imperative ("Please just send..." -> send)."""
    skip = P.POLITENESS_MARKERS | {"just", "also", "then", "so", "ok", "okay", "hi", "hello"}
    for token in sent:
        if token.is_punct or token.is_space or token.lower_ in skip or token.pos_ == "INTJ":
            continue
        return token
    return None


def _is_sentence_initial(token: Token) -> bool:
    return token == _first_content_token(token.sent)


def _is_verb_like(token: Token) -> bool:
    """A verb, or a sentence-initial word the small model mis-tagged ("Email me...").

    Money nouns are excluded from the fallback so "Deposit: $500" is not
    mistaken for the imperative "Deposit $500".
    """
    if token.pos_ == "VERB":
        return True
    return (
        _is_sentence_initial(token)
        and token.pos_ in {"PROPN", "NOUN"}
        and token.lower_ not in P.MONEY_NOUNS
        and _lemma(token) not in P.MONEY_NOUNS
    )


def _is_payment_verb(token: Token) -> bool:
    words = {_lemma(token), token.lower_}
    return bool(words & P.PAYMENT_VERBS) and _is_verb_like(token)


def _is_negated(token: Token) -> bool:
    return any(
        child.dep_ == "neg" or child.lower_ in P.NEGATION_WORDS for child in token.children
    )


def _subjects(token: Token) -> list[Token]:
    return [child for child in token.children if child.dep_ in {"nsubj", "nsubjpass", "expl"}]


def _auxiliaries(token: Token) -> set[str]:
    return {child.lower_ for child in token.children if child.dep_ in {"aux", "auxpass"}}


def _starts_clause(token: Token) -> bool:
    """Whether ``token`` begins its clause: sentence start, or after "please",
    "so", "and", a comma and similar. The "e -" of a split "e-transfer" is
    skipped, so "will e-transfer" and "by e-transfer" do not start a clause.
    """
    sent = token.sent
    start = token.i
    while start > sent.start and sent.doc[start - 1].lower_ in {"e", "-"}:
        start -= 1
    previous = [t for t in sent.doc[sent.start:start] if not t.is_punct and not t.is_space]
    if not previous:
        return True
    lead = previous[-1]
    if sent.doc[start - 1].is_punct and sent.doc[start - 1].text in {",", ";", ":"}:
        return True
    return (
        lead.lower_ in P.POLITENESS_MARKERS
        or lead.lower_ in P.ETRANSFER_COMMAND_LEADS
        or lead.pos_ in {"CCONJ", "INTJ"}
    )


def _is_request(verb: Token) -> bool:
    """Whether ``verb`` asks or tells the renter to do something.

    Recognises imperatives ("Send the deposit"), polite requests ("Please
    transfer"), obligations ("must be sent", "you need to pay", "I need you to
    send") and second-person directives ("you can transfer"). Descriptions
    such as "The deposit is paid at signing" are not requests.
    """
    if _is_negated(verb):
        return False
    if any(token.lower_ in P.POLITENESS_MARKERS for token in verb.sent):
        return True
    if _is_sentence_initial(verb):
        return True

    subjects = _subjects(verb)
    auxiliaries = _auxiliaries(verb)
    if auxiliaries & P.OBLIGATION_AUXILIARIES:
        return True
    # Bare verb with no subject or auxiliary that starts a clause is an
    # imperative, even mid-sentence ("I am overseas so send the deposit").
    if verb.tag_ == "VB" and not subjects and not auxiliaries and _starts_clause(verb):
        return True
    if any(subject.lower_ == "you" for subject in subjects) and auxiliaries & P.DIRECTIVE_AUXILIARIES:
        return True

    head = verb.head
    if verb.dep_ in {"xcomp", "ccomp"} and _lemma(head) in P.OBLIGATION_HEADS:
        if _is_negated(head):
            return False
        head_subjects = [subject.lower_ for subject in _subjects(head)]
        renter_is_actor = any(subject.lower_ == "you" for subject in subjects) or any(
            child.lower_ == "you" for child in head.children if child.dep_ in {"dobj", "dative"}
        )
        # "I want to send you the keys" is the landlord acting, not a request.
        return renter_is_actor or not (set(head_subjects) & P.FIRST_PERSON)
    if verb.dep_ == "conj" and head != verb:
        return _is_request(head)
    return False


def _mentions_money(sent: Span) -> bool:
    return (
        any(_lemma(token) in P.MONEY_NOUNS or token.lower_ in P.MONEY_NOUNS for token in sent)
        or any(_is_payment_verb(token) for token in sent)
        or any(ent.label_ == "MONEY" for ent in sent.ents)
        or bool(_find("money_service", sent))
    )


def _is_etransfer_command(span: Span) -> bool:
    """Whether an e-transfer term is itself the command ("e-transfer $300 tonight").

    The small model often tags "e-transfer" as a noun, so this looks at the
    words around it instead: it must be followed by an amount or object and
    start its clause, not follow "by"/"via" as a payment method.
    """
    sent, doc = span.sent, span.doc
    if span.end >= sent.end:
        return False
    following = doc[span.end]
    takes_object = (
        following.ent_type_ == "MONEY"
        or following.like_num
        or following.lower_ in P.ETRANSFER_COMMAND_OBJECTS
        or _lemma(following) in P.MONEY_NOUNS
    )
    if not takes_object:
        return False
    return _starts_clause(doc[span.end - 1])


def _has_payment_request(sent: Span) -> bool:
    return any(_is_payment_verb(token) and _is_request(token) for token in sent) or any(
        _is_etransfer_command(span) for span in _find("etransfer", sent)
    )


def _names_payment(sent: Span) -> bool:
    return any(ent.label_ == "MONEY" for ent in sent.ents) or any(
        token.text == "$" or _lemma(token) in P.MONEY_NOUNS for token in sent
    )


# ---------------------------------------------------------------------------
# Warning sign 1: deposit demand
# ---------------------------------------------------------------------------

def detect_deposit_demand(text) -> DetectionResult:
    """Detect a request to send a deposit or payment to reserve the property.

    A sentence counts when it mentions a deposit (or an amount paid to hold
    the unit), contains a payment verb and
    either phrases it as a request, ties it to holding the unit, or makes it a
    race ("first person to send the deposit"). Paying at lease signing or
    move-in is treated as normal unless the same sentence adds a reservation
    or urgency cue.
    """
    evidence = []
    for sent in _sentences(text):
        first_to_pay = bool(_find("first_to_pay", sent))
        reserves_unit = any(
            _lemma(token) in P.RESERVATION_VERBS and token.pos_ == "VERB" for token in sent
        )
        # A deposit by name, or any amount paid to hold the unit ("$300 to lock it in").
        if not (_find("deposit", sent) or (reserves_unit and _names_payment(sent))):
            continue
        has_payment_action = any(_is_payment_verb(token) for token in sent) or any(
            _is_etransfer_command(span) for span in _find("etransfer", sent)
        )
        if not has_payment_action:
            continue

        requested = _has_payment_request(sent)
        urgent = bool(_find("urgency", sent))
        if not (requested or reserves_unit or first_to_pay):
            continue
        if _find("lease_signing", sent) and not (reserves_unit or urgent or first_to_pay):
            continue
        evidence.append(sent.text.strip())
    return _result(evidence)


# ---------------------------------------------------------------------------
# Warning sign 2: personal information request
# ---------------------------------------------------------------------------

def detect_personal_information_request(text) -> DetectionResult:
    """Detect a request for sensitive personal or financial information.

    Needs a sensitive-information term (SIN, passport, banking details...)
    that comes after either a sending verb used as a request ("send me your
    passport") or a first-person need ("I need your SIN"). Statements such as
    "You will need government ID at signing" are not requests.
    """
    evidence = []
    for sent in _sentences(text):
        info_spans = _find("sensitive_info", sent)
        if not info_spans:
            continue
        for token in sent:
            if not any(span.start > token.i for span in info_spans):
                continue
            words = {_lemma(token), token.lower_}
            asks_to_send = (
                words & P.INFO_REQUEST_VERBS and _is_verb_like(token) and _is_request(token)
            )
            landlord_needs = (
                words & P.INFO_NEED_VERBS
                and not _is_negated(token)
                and any(subject.lower_ in P.FIRST_PERSON for subject in _subjects(token))
            )
            if asks_to_send or landlord_needs:
                evidence.append(sent.text.strip())
                break
    return _result(evidence)


# ---------------------------------------------------------------------------
# Warning sign 3: e-transfer request
# ---------------------------------------------------------------------------

def _transfers_money(verb: Token) -> bool:
    """Whether a plain "transfer" verb is about money ("transfer the funds")."""
    for token in verb.subtree:
        if token == verb:
            continue
        if _lemma(token) in P.MONEY_NOUNS or token.lower_ in P.MONEY_NOUNS:
            return True
        if token.ent_type_ == "MONEY" or token.text == "$":
            return True
        if token.lower_ in P.TRANSFER_DESTINATION_WORDS and token.head.lower_ == "to":
            return True
    return False


def detect_etransfer_request(text) -> DetectionResult:
    """Detect a request to pay by electronic transfer.

    Fires when an e-transfer term (e-transfer, Interac, EMT, wire transfer...)
    appears in a sentence with a payment request, or when "transfer" is used
    as a request to move money ("Please transfer the $1,000 deposit").
    Mentions of accepted payment methods without a request, and unrelated uses
    of "transfer", do not fire.
    """
    evidence = []
    for sent in _sentences(text):
        has_etransfer_term = bool(_find("etransfer", sent))
        requested = _has_payment_request(sent)
        plain_transfer = any(
            _lemma(token) == "transfer"
            and _is_verb_like(token)
            and _is_request(token)
            and _transfers_money(token)
            for token in sent
        )
        if (has_etransfer_term and requested) or plain_transfer:
            evidence.append(sent.text.strip())
    return _result(evidence)


# ---------------------------------------------------------------------------
# Warning sign 4: high-demand claim
# ---------------------------------------------------------------------------

def _is_preceded_by_negation(span: Span) -> bool:
    doc = span.doc
    before = doc[max(span.start - 2, span.sent.start):span.start]
    return any(token.lower_ in P.NEGATION_WORDS | {"without"} for token in before)


def _describes_amenity(span: Span) -> bool:
    """"First come first served parking" is about an amenity, not the unit."""
    following = span.doc[span.end:min(span.end + 4, span.sent.end)]
    return any(_lemma(token) in P.AMENITY_NOUNS for token in following)


def detect_high_demand_claim(text) -> DetectionResult:
    """Detect claims that many others want the unit or that it will go fast.

    Combines three signals: competing-demand nouns ("several applicants",
    "multiple offers", "high demand"), groups of people paired with an
    interest word ("lots of people are interested"), and scarcity/competition
    phrases ("first come first served", "won't last", "before someone else").
    Plain availability ("available immediately") does not fire.
    """
    evidence = []
    for sent in _sentences(text):
        demand = [span for span in _find("demand", sent) if not _is_preceded_by_negation(span)]
        scarcity = [span for span in _find("scarcity", sent) if not _describes_amenity(span)]
        interested_people = [
            span
            for span in _find("people_demand", sent)
            if not _is_preceded_by_negation(span)
            and any(
                _lemma(token) in P.INTEREST_WORDS or token.lower_ in P.INTEREST_WORDS
                for token in sent
                if token.i >= span.end
            )
        ]
        if demand or scarcity or interested_people:
            evidence.append(sent.text.strip())
    return _result(evidence)


# ---------------------------------------------------------------------------
# Warning sign 5: foreign payment destination
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _foreign_names() -> frozenset[str]:
    return frozenset(_normalize_place(place) for place in P.FOREIGN_PLACES) | frozenset(
        P.FOREIGN_ACRONYMS
    )


def _normalize_place(text: str) -> str:
    text = text.strip()
    return text[4:] if text.lower().startswith("the ") else text


def _is_foreign(span: Span) -> bool:
    name = _normalize_place(span.text)
    if name.lower() in P.CANADIAN_PLACES:
        return False
    return name in P.FOREIGN_ACRONYMS or name.lower() in {n.lower() for n in _foreign_names()}


def _foreign_places(sent: Span) -> list[Span]:
    """Foreign places from NER, backed up by the gazetteer when NER misses one."""
    candidates = [ent for ent in sent.ents if ent.label_ in {"GPE", "LOC"}]
    candidates += _find("foreign_places", sent) + _find("foreign_acronyms", sent)
    places, seen = [], set()
    for span in candidates:
        if span.root.i in seen or not _is_foreign(span):
            continue
        seen.add(span.root.i)
        places.append(span)
    return places


def _is_payment_destination(place: Span) -> bool:
    """Whether a place is where the money goes, following the dependency tree upward.

    "to my brother in Mexico" and "my account in the UK" climb to a recipient;
    "send the money to Mexico" climbs to a payment verb; "I live in France, so
    please send the deposit" climbs to a location verb in a sentence that also
    requests money. "I grew up in Mexico" stops at an unrelated verb.
    """
    for ancestor in place.root.ancestors:
        if ancestor.sent != place.sent:
            break
        lemma = _lemma(ancestor)
        if lemma in P.RECIPIENT_NOUNS or ancestor.lower_ in P.RECIPIENT_NOUNS:
            return True
        if lemma in P.MONEY_NOUNS or _is_payment_verb(ancestor):
            return True
        if lemma in P.LOCATED_VERBS:
            return _has_payment_request(place.sent)
        if ancestor.pos_ in {"VERB", "AUX"}:
            return False
    return False


def detect_foreign_payment_destination(text) -> DetectionResult:
    """Detect instructions to send money to a person or account outside Canada.

    A foreign place (spaCy NER plus a country gazetteer, excluding Canadian
    places) must be grammatically linked to a payment or its recipient, in a
    sentence that is about money. Phrases such as "overseas" or "out of the
    country" count when the sentence also asks for payment. Mentioning a
    country on its own ("I grew up in Mexico") does not fire.
    """
    evidence = []
    for sent in _sentences(text):
        if not _mentions_money(sent):
            continue
        linked_place = any(_is_payment_destination(place) for place in _foreign_places(sent))
        abroad = bool(_find("abroad", sent)) and _has_payment_request(sent)
        if linked_place or abroad:
            evidence.append(sent.text.strip())
    return _result(evidence)
