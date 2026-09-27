"""Reusable linguistic patterns for the warning-sign detectors.

Everything the detectors look for lives here so the lists can grow without
touching detector logic. Word lists are matched against spaCy lemmas or
lowercased tokens; token patterns use spaCy ``Matcher`` syntax.
"""

# ---------------------------------------------------------------------------
# Shared vocabulary
# ---------------------------------------------------------------------------

# Verbs that move money from the renter to someone else.
PAYMENT_VERBS = {
    "send", "pay", "transfer", "wire", "e-transfer", "etransfer", "interac",
    "leave", "put", "submit", "forward", "mail", "remit", "drop", "deposit",
    "give", "make", "go",
}

# Nouns that refer to money or a payment.
MONEY_NOUNS = {
    "deposit", "payment", "money", "fund", "funds", "rent", "cash", "fee",
    "amount", "dollar", "buck", "sum",
}

# Words that soften a direct request ("Please send...").
POLITENESS_MARKERS = {"please", "pls", "plz", "kindly"}

# Auxiliaries that turn a verb into an obligation ("must send").
OBLIGATION_AUXILIARIES = {"must", "should", "need", "needs", "ought", "gotta"}

# Head verbs whose complement is an obligation or request
# ("you need to send", "I need you to send", "you have to pay").
OBLIGATION_HEADS = {"need", "have", "require", "want", "ask", "expect", "got"}

# Auxiliaries that, with a "you" subject, direct the renter to act
# ("you can transfer", "you will pay").
DIRECTIVE_AUXILIARIES = {"can", "could", "will", "'ll", "would"}

# Words that negate a request ("I will never ask for...").
NEGATION_WORDS = {"not", "n't", "never", "no"}

# ---------------------------------------------------------------------------
# Warning sign 1: deposit demand
# ---------------------------------------------------------------------------

DEPOSIT_TERM_PATTERNS = [
    [{"LEMMA": "deposit"}],
    [{"LOWER": "down"}, {"LEMMA": "payment"}],
    [{"LOWER": {"IN": ["holding", "reservation", "reserve", "booking"]}},
     {"LEMMA": {"IN": ["fee", "payment", "deposit"]}}],
    [{"LOWER": "first"}, {"LOWER": {"IN": ["month", "months", "month's"]}},
     {"LOWER": "'s", "OP": "?"}, {"LOWER": "rent", "OP": "?"}],
    [{"LOWER": "first"}, {"LOWER": "and"}, {"LOWER": "last"}],
]

# Securing the unit in exchange for money ("to hold the apartment").
RESERVATION_VERBS = {"hold", "reserve", "secure", "save", "lock", "keep", "guarantee", "claim"}

# Time pressure attached to the payment ("today", "before I remove the listing").
URGENCY_PATTERNS = [
    [{"LOWER": {"IN": ["today", "tonight", "now", "immediately", "asap", "tomorrow"]}}],
    [{"LOWER": "right"}, {"LOWER": {"IN": ["away", "now"]}}],
    [{"LOWER": "as"}, {"LOWER": "soon"}, {"LOWER": "as"}, {"LOWER": "possible"}],
    [{"LOWER": "within"}, {"LIKE_NUM": True, "OP": "?"},
     {"LEMMA": {"IN": ["hour", "day", "minute"]}}],
    [{"LOWER": "before"}, {"LOWER": {"IN": ["i", "someone", "somebody", "anyone", "it", "the"]}}],
]

# "First person to send the deposit gets it."
FIRST_TO_PAY_PATTERNS = [
    [{"LOWER": "first"}, {"LEMMA": {"IN": ["person", "one", "people", "applicant"]}},
     {"LOWER": {"IN": ["to", "who", "that"]}}],
]

# Paying at lease signing or move-in is normal practice, not a reservation demand.
LEASE_SIGNING_PATTERNS = [
    [{"LEMMA": "sign"}, {"IS_ALPHA": True, "OP": "{0,3}"},
     {"LEMMA": {"IN": ["lease", "agreement", "contract", "tenancy"]}}],
    [{"LEMMA": {"IN": ["lease", "contract"]}}, {"LEMMA": "signing"}],
    [{"LOWER": {"IN": ["upon", "at"]}}, {"LEMMA": "signing"}],
    [{"LOWER": "move"}, {"LOWER": "-", "OP": "?"}, {"LOWER": "in"}],
    [{"LOWER": "move-in"}],
    [{"LEMMA": "get"}, {"LOWER": "the", "OP": "?"}, {"LEMMA": "key"}],
]

# ---------------------------------------------------------------------------
# Warning sign 2: personal information request
# ---------------------------------------------------------------------------

SENSITIVE_INFO_PATTERNS = [
    [{"ORTH": {"IN": ["SIN", "S.I.N.", "SSN"]}}],
    [{"LOWER": "social"}, {"LOWER": {"IN": ["insurance", "security"]}}, {"LOWER": "number"}],
    [{"LOWER": {"IN": ["driver", "drivers", "driver's"]}}, {"LOWER": "'s", "OP": "?"},
     {"LOWER": {"IN": ["licence", "license", "licences", "licenses"]}}],
    [{"LEMMA": "passport"}],
    [{"LOWER": {"IN": ["government", "photo", "picture", "gov't", "govt"]}},
     {"LOWER": "-", "OP": "?"}, {"LOWER": {"IN": ["id", "identification", "ids"]}}],
    [{"ORTH": {"IN": ["ID", "IDs", "I.D."]}}],
    [{"LOWER": "your"}, {"LOWER": {"IN": ["id", "identification"]}}],
    [{"LOWER": "identification"}],
    [{"LOWER": "bank"}, {"LOWER": {"IN": ["account", "details", "info", "information",
                                            "login", "password", "statement", "card"]}}],
    [{"LOWER": "banking"}, {"LOWER": {"IN": ["information", "info", "details", "credentials",
                                               "login", "password", "username"]}}],
    [{"LOWER": "online"}, {"LOWER": "banking"}],
    [{"LOWER": "account"}, {"LOWER": {"IN": ["number", "numbers", "details", "password"]}}],
    [{"LOWER": "credit"}, {"LOWER": "card"}],
    [{"LOWER": {"IN": ["card", "pin"]}}, {"LOWER": "number"}],
    [{"ORTH": {"IN": ["CVV", "CVC", "PIN"]}}],
    [{"LOWER": "date"}, {"LOWER": "of"}, {"LOWER": "birth"}],
    [{"ORTH": {"IN": ["DOB", "D.O.B."]}}],
    [{"LOWER": "birth"}, {"LOWER": "certificate"}],
    [{"LOWER": "mother"}, {"LOWER": "'s", "OP": "?"}, {"LOWER": "maiden"}, {"LOWER": "name"}],
    [{"LOWER": "health"}, {"LOWER": "card"}],
]

# Verbs that ask the renter to hand information over.
INFO_REQUEST_VERBS = {
    "send", "email", "e-mail", "text", "provide", "give", "share", "upload", "submit",
    "forward", "attach", "fill", "enter", "mail", "fax", "scan", "include", "dm", "message",
}

# Verbs that ask for information only when the landlord is the subject
# ("I need your SIN", not "You will need government ID").
INFO_NEED_VERBS = {"need", "require", "want"}
FIRST_PERSON = {"i", "we"}

# ---------------------------------------------------------------------------
# Warning sign 3: e-transfer request
# ---------------------------------------------------------------------------

ETRANSFER_PATTERNS = [
    [{"LOWER": "e"}, {"LOWER": "-", "OP": "?"},
     {"LOWER": {"IN": ["transfer", "transfers", "transferred", "transferring"]}}],
    [{"LOWER": {"IN": ["etransfer", "etransfers", "e-transfer", "e-transfers",
                        "etransferred", "etransfering", "etransferring"]}}],
    [{"LOWER": "interac"}],
    [{"ORTH": "EMT"}],
    [{"LOWER": {"IN": ["email", "e-mail"]}}, {"LOWER": "money"}, {"LOWER": {"IN": ["transfer", "transfers"]}}],
    [{"LOWER": {"IN": ["wire", "bank", "electronic"]}}, {"LOWER": {"IN": ["transfer", "transfers"]}}],
    [{"LOWER": {"IN": ["wire", "wired", "wiring"]}}],
]

# Words that can follow an e-transfer term used as a command
# ("e-transfer $300", "Interac the money", "etransfer me").
ETRANSFER_COMMAND_OBJECTS = {"the", "me", "it", "your", "my", "him", "her", "us", "them",
                             "that", "this", "$"}

# Words that can come right before an e-transfer term used as a command.
ETRANSFER_COMMAND_LEADS = {"so", "and", "then", "just", "or", "now"}

# Where the money should go ("to this email").
TRANSFER_DESTINATION_WORDS = {"email", "e-mail", "account", "address", "number", "me", "phone"}

# ---------------------------------------------------------------------------
# Warning sign 4: high-demand claim
# ---------------------------------------------------------------------------

DEMAND_QUANTIFIERS = [
    "lots", "lot", "many", "several", "multiple", "numerous", "tons", "ton", "plenty",
    "few", "bunch", "dozens", "dozen", "hundreds", "countless", "other", "more",
]

# Nouns that already imply competing renters ("multiple offers").
DEMAND_NOUNS = [
    "applicant", "application", "offer", "inquiry", "enquiry", "message", "request",
    "response", "email", "call", "bid", "candidate", "interest",
]

# Nouns that need an interest predicate ("many people" + "interested").
PEOPLE_NOUNS = ["people", "person", "other", "party", "renter", "family", "student",
                "individual", "one", "folk", "tenant"]

INTEREST_WORDS = {
    "interested", "interest", "ready", "wait", "waiting", "apply", "line", "lined",
    "compete", "competing", "want", "ask", "asking", "inquire", "view", "viewing", "look",
    "looking", "contact", "message", "email", "call", "keen", "eager", "take", "rent",
}

DEMAND_PATTERNS = [
    [{"LOWER": {"IN": DEMAND_QUANTIFIERS}}, {"LOWER": "of", "OP": "?"},
     {"POS": "ADJ", "OP": "*"}, {"LEMMA": {"IN": DEMAND_NOUNS}}],
    [{"LOWER": {"IN": ["high", "huge", "big", "strong", "great", "heavy", "overwhelming"]}},
     {"LEMMA": {"IN": ["demand", "interest", "response"]}}],
    [{"LOWER": "in"}, {"LOWER": "demand"}],
    [{"LOWER": {"IN": ["someone", "somebody"]}}, {"LOWER": "else"}],
    [{"LOWER": "other"}, {"LOWER": "interested"}],
]

PEOPLE_DEMAND_PATTERNS = [
    [{"LOWER": {"IN": DEMAND_QUANTIFIERS}}, {"LOWER": "of", "OP": "?"},
     {"POS": "ADJ", "OP": "*"}, {"LEMMA": {"IN": PEOPLE_NOUNS}}],
    [{"LOWER": "others"}],
]

# Scarcity and competition ("won't last", "first come first served").
SCARCITY_PATTERNS = [
    [{"LOWER": "first"}, {"LOWER": "come"}, {"LOWER": ",", "OP": "?"}, {"LOWER": "first"},
     {"LOWER": {"IN": ["serve", "served"]}}],
    [{"LOWER": "first"}, {"LEMMA": {"IN": ["person", "one", "people", "applicant"]}},
     {"LOWER": {"IN": ["to", "who", "that"]}}],
    [{"LOWER": {"IN": ["wo", "will"]}}, {"LOWER": {"IN": ["n't", "not"]}},
     {"LEMMA": {"IN": ["last", "stay"]}}],
    [{"LOWER": {"IN": ["wo", "will"]}}, {"LOWER": {"IN": ["n't", "not"]}}, {"LEMMA": "be"},
     {"LOWER": {"IN": ["available", "around", "on", "here", "up"]}},
     {"LOWER": {"IN": ["for", "the", "market"]}, "OP": "*"}, {"LOWER": "long"}],
    [{"LOWER": "not"}, {"LOWER": "for"}, {"LOWER": "long"}],
    [{"LEMMA": "go"}, {"LOWER": {"IN": ["fast", "quickly", "quick"]}}],
    [{"LOWER": "before"}, {"LOWER": {"IN": ["someone", "somebody", "others"]}}],
    [{"LOWER": "before"}, {"LOWER": "it"}, {"LOWER": {"IN": ["is", "'s"]}},
     {"LOWER": {"IN": ["gone", "taken", "rented"]}}],
    [{"LEMMA": "be"}, {"LOWER": "gone"}, {"LOWER": {"IN": ["soon", "fast", "quickly"]}}],
    [{"LOWER": {"IN": ["do", "don't"]}}, {"LOWER": "n't", "OP": "?"}, {"LOWER": "miss"},
     {"LOWER": "out"}],
]

# Scarcity phrases followed by these describe a building amenity
# ("first come first served parking"), not demand for the unit.
AMENITY_NOUNS = {"parking", "lot", "stall", "spot", "storage", "locker", "laundry", "bike", "garage"}

# ---------------------------------------------------------------------------
# Warning sign 5: foreign payment destination
# ---------------------------------------------------------------------------

# People or accounts that can receive money on the landlord's behalf.
RECIPIENT_NOUNS = {
    "brother", "sister", "mother", "father", "mom", "dad", "parent", "son", "daughter",
    "cousin", "uncle", "aunt", "wife", "husband", "partner", "friend", "family", "relative",
    "assistant", "agent", "lawyer", "attorney", "representative", "secretary", "manager",
    "colleague", "account", "bank", "office", "company", "me",
}

# Verbs describing where the landlord lives or works, used when a foreign place
# is tied to the landlord and money is requested in the same sentence.
LOCATED_VERBS = {"live", "stay", "reside", "work", "base", "locate", "relocate", "move", "travel"}

# Words meaning "outside the country" without naming a place.
ABROAD_PATTERNS = [
    [{"LOWER": {"IN": ["overseas", "abroad", "offshore"]}}],
    [{"LOWER": "out"}, {"LOWER": "of"}, {"LOWER": "the"}, {"LOWER": "country"}],
    [{"LOWER": "outside"}, {"LOWER": "of", "OP": "?"},
     {"LOWER": {"IN": ["canada", "the"]}}, {"LOWER": "country", "OP": "?"}],
    [{"LOWER": "international"}, {"LEMMA": {"IN": ["account", "transfer", "bank"]}}],
]

# Money services commonly used to send funds abroad.
MONEY_SERVICE_PATTERNS = [
    [{"LOWER": "western"}, {"LOWER": "union"}],
    [{"LOWER": "moneygram"}],
    [{"LOWER": "money"}, {"LOWER": "gram"}],
]

# Countries and major foreign cities. NER finds place names; this list decides
# which ones are outside Canada and backs up NER when it misses a country.
FOREIGN_PLACES = [
    "Afghanistan", "Albania", "Algeria", "Argentina", "Armenia", "Australia", "Austria",
    "Bahamas", "Bangladesh", "Belarus", "Belgium", "Bolivia", "Brazil", "Bulgaria",
    "Cambodia", "Cameroon", "Chile", "China", "Colombia", "Costa Rica", "Croatia", "Cuba",
    "Cyprus", "Czech Republic", "Czechia", "Denmark", "Dominican Republic", "Dubai",
    "Ecuador", "Egypt", "El Salvador", "England", "Estonia", "Ethiopia", "Fiji", "Finland",
    "France", "Germany", "Ghana", "Greece", "Guatemala", "Haiti", "Honduras",
    "Hong Kong", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland",
    "Israel", "Italy", "Ivory Coast", "Jamaica", "Japan", "Kazakhstan", "Kenya",
    "Korea", "South Korea", "Kuwait", "Laos", "Latvia", "Lebanon", "Libya", "Lithuania",
    "Luxembourg", "Malaysia", "Mali", "Malta", "Mexico", "Moldova", "Mongolia", "Morocco",
    "Nepal", "Netherlands", "Holland", "New Zealand", "Nicaragua", "Nigeria", "Norway",
    "Oman", "Pakistan", "Panama", "Paraguay", "Peru", "Philippines", "the Philippines",
    "Poland", "Portugal", "Qatar", "Romania", "Russia", "Rwanda", "Saudi Arabia", "Scotland",
    "Senegal", "Serbia", "Singapore", "Slovakia", "Slovenia", "South Africa", "Spain",
    "Sri Lanka", "Sudan", "Sweden", "Switzerland", "Syria", "Taiwan", "Tanzania", "Thailand",
    "Tunisia", "Turkey", "Uganda", "Ukraine", "United Arab Emirates",
    "United Kingdom", "the United Kingdom", "United States", "the United States",
    "America", "Uruguay", "Venezuela", "Vietnam", "Wales",
    "Yemen", "Zambia", "Zimbabwe",
    "London", "Paris", "Lagos", "Abuja", "Accra", "Manila", "Mexico City", "New York",
    "Los Angeles", "Beijing", "Shanghai", "Delhi", "New Delhi", "Mumbai", "Istanbul",
    "Moscow", "Madrid", "Rome", "Berlin", "Tokyo", "Seoul", "Bangkok", "Singapore", "Sydney",
]

# Country abbreviations, matched case-sensitively so "us" the pronoun never counts.
FOREIGN_ACRONYMS = ["UK", "U.K.", "US", "U.S.", "USA", "U.S.A.", "UAE", "U.A.E."]

# Places that are in Canada and must never count as a foreign destination.
CANADIAN_PLACES = {
    "canada", "bc", "b.c.", "british columbia", "alberta", "ontario", "quebec", "manitoba",
    "saskatchewan", "nova scotia", "new brunswick", "newfoundland", "pei", "yukon",
    "nunavut", "northwest territories", "vancouver", "burnaby", "richmond", "surrey",
    "coquitlam", "north vancouver", "west vancouver", "new westminster", "delta", "langley",
    "victoria", "kelowna", "calgary", "edmonton", "toronto", "ottawa", "montreal", "winnipeg",
    "halifax", "regina", "saskatoon", "kitsilano", "ubc",
}
