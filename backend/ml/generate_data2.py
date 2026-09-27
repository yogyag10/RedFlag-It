"""Generate ml/data2.json: 500 labelled Vancouver rental listings for training.

    python -m ml.generate_data2

Keeps the 25 hand-labelled listings in ml/data.json (20 real Facebook
Marketplace listings, 5 written scam examples) and adds 475 generated ones
(380 real, 95 fake) so the classes are 400 real / 100 fake.

Generated real and fake listings are built from the same titles, neighbourhoods,
feature lines and writing styles, with overlapping prices. The only intended
difference is scam behaviour from the RCMP BC rental-scam guidance (payment
before viewing, landlord abroad, money sent outside Canada, e-transfer/wire
requests, identity or verification-code requests, pressure, no lease). Some
real listings mention deposits and e-transfer in the normal way (at lease
signing, as a payment option) so the model cannot rely on the words alone.
Generated listings have no photos or source URLs.
"""

import json
import random
from pathlib import Path

ML_DIR = Path(__file__).resolve().parent
SEED = 2026
N_REAL, N_FAKE = 380, 95

NEIGHBOURHOODS = [
    # name, latitude, longitude, rent multiplier
    ("Kitsilano", 49.2680, -123.1630, 1.15), ("West End", 49.2860, -123.1360, 1.10),
    ("Yaletown", 49.2750, -123.1210, 1.25), ("Coal Harbour", 49.2890, -123.1220, 1.35),
    ("Downtown", 49.2810, -123.1170, 1.20), ("Mount Pleasant", 49.2630, -123.1000, 1.05),
    ("Fairview", 49.2620, -123.1290, 1.10), ("Commercial Drive", 49.2690, -123.0690, 1.00),
    ("Strathcona", 49.2780, -123.0880, 0.95), ("Hastings-Sunrise", 49.2790, -123.0400, 0.92),
    ("Riley Park", 49.2440, -123.1030, 1.00), ("Kerrisdale", 49.2340, -123.1560, 1.10),
    ("Dunbar", 49.2480, -123.1860, 1.05), ("Point Grey", 49.2650, -123.1990, 1.12),
    ("Marpole", 49.2100, -123.1300, 0.90), ("Killarney", 49.2220, -123.0440, 0.88),
    ("Renfrew-Collingwood", 49.2480, -123.0420, 0.88), ("South Cambie", 49.2460, -123.1210, 1.08),
]

UNITS = [
    # title unit, bedrooms, base monthly rent (calibrated so generated real
    # listings have about the same median price as the real Facebook sample)
    ("Studio 1 Bath", 0, 1400), ("1 Bed 1 Bath", 1, 1650), ("1 Bed 1 Bath", 1, 1750),
    ("2 Beds 1 Bath", 2, 2150), ("2 Beds 2 Baths", 2, 2450), ("3 Beds 2 Baths", 3, 3000),
    ("3 Beds 1.5 Baths", 3, 2750),
]
PROPERTY_TYPES = ["Apartment", "Apartment", "Apartment", "House", "Townhouse", "Condo"]

OPENERS = [
    "{beds_text} {ptype_lower} available in {hood}.",
    "Bright and spacious {beds_text} {ptype_lower} in {hood}.",
    "Clean, well kept {beds_text} suite in the heart of {hood}.",
    "{hood} {beds_text} for rent, available {available}.",
    "Updated {beds_text} {ptype_lower} on a quiet street in {hood}.",
    "Lovely {beds_text} home close to everything {hood} has to offer.",
]
FEATURES = [
    "In-suite laundry.", "Shared laundry in the building.", "New stainless steel appliances.",
    "Hardwood floors throughout.", "Large private balcony.", "Lots of natural light.",
    "Heat and hot water included.", "Utilities extra.", "One underground parking stall included.",
    "Street parking only.", "Storage locker included.", "Dishwasher and microwave.",
    "Gas fireplace in the living room.", "Fenced backyard.", "Freshly painted.",
    "Walk-in closet in the main bedroom.", "Bike storage in the building.", "Air conditioning.",
]
LOCATION_LINES = [
    "Close to transit, shops, and parks.", "A few minutes walk to the SkyTrain.",
    "Bus stop right out front.", "Walking distance to grocery stores and cafes.",
    "Easy commute to downtown and UBC.", "Steps from restaurants and the seawall.",
]
AVAILABILITY = ["October 1", "November 1", "now", "mid October", "December 1"]
POLICY_LINES = [
    "No smoking.", "No pets please.", "Small pets considered.", "Cat friendly.",
    "Minimum one year lease.", "Month to month after the first year.", "Suitable for a couple or a single professional.",
]

# Normal rental process. Some mention deposits or e-transfer legitimately.
LEGIT_PROCESS = [
    "Please message me to book a viewing.",
    "Viewings by appointment this weekend.",
    "Open house on Saturday from 2 to 4pm.",
    "Credit check and references required.",
    "Tenant insurance required.",
    "Please include a short introduction, move-in date and number of occupants when you reach out.",
    "Security deposit is half a month's rent, due when the lease is signed.",
    "A damage deposit of half a month's rent is collected at lease signing after the viewing.",
    "Rent can be paid by e-transfer or post-dated cheques once the lease is signed.",
    "The owner lives upstairs and will show the suite in person.",
    "Professionally managed building; applications through our office after the viewing.",
    "There is a first come first served parking spot behind the building.",
    "Standard BC residential tenancy agreement.",
]

# Ordinary first-person landlord lines, used by both classes so that talking
# like a person ("I", "my", "send me") is not itself a fake-listing signal.
PERSONAL_LINES = [
    "I'm the owner and I live nearby, so I can show the unit most evenings.",
    "Feel free to send me a message or email with your questions.",
    "I'll send you the address once we book a time to view.",
    "Text me if you have any questions, I usually reply the same day.",
    "Please have your references ready before the viewing.",
    "It is a great unit for someone who works downtown.",
    "Just message me here to set up a time.",
    "My last tenants stayed four years and we are sad to see them go.",
    "The current tenant is still moving out, so viewings start next week.",
    "I don't allow smoking anywhere on the property.",
    "Payment of the first month's rent is made when you sign the lease in person.",
    "I need a few days notice to arrange a showing as it is still occupied.",
    "So far it has been a very quiet building, which we love.",
    "Today I added a few more photos of the kitchen.",
]

COUNTRIES = ["Dubai", "the UK", "Nigeria", "Mexico", "the Philippines", "France", "Malaysia", "Germany"]
RELATIONS = ["brother", "sister", "cousin", "agent", "lawyer", "assistant"]

# Scam behaviour, grouped by type; each fake draws 1-3 different types.
SCAM_LINES = {
    "pay_before_viewing": [
        "Send a ${deposit} deposit to reserve the unit before the viewing.",
        "The deposit must be paid before I can show the suite.",
        "To book a viewing, please e-transfer the ${fee} application fee first.",
        "I only arrange viewings once the ${deposit} holding deposit is received.",
    ],
    "landlord_abroad": [
        "I am currently working overseas in {country} so I cannot show the unit in person.",
        "I'm out of the country for work right now, my {relation} will mail you the keys.",
        "I recently relocated to {country} and can't meet, but the keys will be couriered to you.",
        "I travel a lot for work so viewings are not possible, the keys will be shipped after payment.",
    ],
    "foreign_payment": [
        "Please e-transfer the deposit to my {relation} in {country}.",
        "Wire the first month's rent to my account in {country} to secure the place.",
        "Payment goes to my {relation} in {country} who handles the rental.",
        "Send the deposit by Western Union to my {relation} in {country}.",
    ],
    "etransfer_request": [
        "E-transfer the ${deposit} holding fee today to hold it.",
        "Please send the deposit by e-transfer to my email and I'll take the ad down.",
        "Payment by wire transfer or Western Union only.",
        "Interac the ${deposit} to me to lock it in.",
    ],
    "personal_info": [
        "Send me a photo of your driver's licence and your SIN so I can pre-approve you.",
        "Before I share the address I need your date of birth and banking information.",
        "Please text me the 6-digit verification code I send you to confirm you are a real person.",
        "Email me a copy of your passport and bank statement to apply.",
    ],
    "pressure": [
        "Lots of people are interested, first person to send the deposit gets it.",
        "I already have several applicants so this won't last.",
        "Act fast, I have multiple offers.",
        "Many people are asking about it, so decide today.",
    ],
    "no_lease": [
        "No need to sign anything now, just send the deposit and I'll email the lease after.",
        "No viewings at this time as the current tenant is still moving out.",
        "I will send the lease online once payment is received.",
    ],
    "off_platform": [
        "Contact me on WhatsApp only, I don't check Facebook.",
        "Email me directly at the address in my profile, I rarely check messages here.",
        "Text me for fast reply, I don't use Marketplace chat.",
    ],
}


def _beds_text(bedrooms: int) -> str:
    return "studio" if bedrooms == 0 else f"{bedrooms} bedroom"


def _title(rng, unit_title, ptype, beds_text, hood) -> str:
    style = rng.random()
    if style < 0.45:
        return f"{unit_title} - {ptype}"
    if style < 0.75:
        return f"{unit_title} {ptype}"
    return rng.choice([
        f"Bright {beds_text} in {hood}", f"{hood} {beds_text} {ptype.lower()} for rent",
        f"Spacious {beds_text} near {hood}", f"{beds_text.capitalize()} suite - {hood}",
    ])


def _join(rng, lines) -> str:
    separator = rng.choice(["\n", "\n", " "])
    return separator.join(lines)


def make_listing(rng, fake: bool) -> dict:
    hood, lat, lon, multiplier = rng.choice(NEIGHBOURHOODS)
    unit_title, bedrooms, base_rent = rng.choice(UNITS)
    ptype = rng.choice(PROPERTY_TYPES)
    beds_text = _beds_text(bedrooms)
    market = base_rent * multiplier

    # Fakes are usually underpriced but not always; some real listings are cheap too.
    if fake:
        factor = rng.uniform(0.55, 0.85) if rng.random() < 0.7 else rng.uniform(0.9, 1.1)
    else:
        factor = rng.uniform(0.75, 0.9) if rng.random() < 0.15 else rng.uniform(0.9, 1.25)
    price = int(round(market * factor / 25) * 25)

    fields = {"beds_text": beds_text, "ptype_lower": ptype.lower(), "hood": hood,
              "available": rng.choice(AVAILABILITY)}
    lines = [rng.choice(OPENERS).format(**fields)]
    lines += rng.sample(FEATURES, rng.randint(2, 5))
    if rng.random() < 0.7:
        lines.append(rng.choice(LOCATION_LINES))
    lines.append(f"${price:,}/month." if rng.random() < 0.6 else f"Rent is {price} per month.")
    lines += rng.sample(POLICY_LINES, rng.randint(1, 2))

    if fake:
        subtle = rng.random() < 0.25
        kinds = rng.sample(sorted(SCAM_LINES), 1 if subtle else rng.randint(2, 3))
        values = {"deposit": int(round(price * rng.choice([0.5, 1.0]) / 25) * 25),
                  "fee": rng.choice([100, 150, 200, 250]),
                  "country": rng.choice(COUNTRIES), "relation": rng.choice(RELATIONS)}
        scam = [rng.choice(SCAM_LINES[kind]).format(**values) for kind in kinds]
        # Scammers often copy normal-sounding process lines too.
        if rng.random() < 0.4:
            scam.append(rng.choice(LEGIT_PROCESS[:5]))
        lines += scam
        if rng.random() < 0.5:
            lines.insert(rng.randint(1, len(lines)), rng.choice(PERSONAL_LINES))
    else:
        lines += rng.sample(LEGIT_PROCESS, rng.randint(1, 3))
        if rng.random() < 0.7:
            lines += rng.sample(PERSONAL_LINES, rng.randint(1, 2))

    return {
        "title": _title(rng, unit_title, ptype, beds_text, hood),
        "description": _join(rng, lines),
        "price": price,
        "currency": "CAD",
        "price_period": "month",
        "location_text": "Vancouver",
        "latitude": round(lat + rng.uniform(-0.006, 0.006), 5),
        "longitude": round(lon + rng.uniform(-0.008, 0.008), 5),
        "image_urls": [],
        "source_url": None,
        "Fake?": fake,
    }


def generate(seed: int = SEED) -> list[dict]:
    rng = random.Random(seed)
    hand_labelled = json.loads((ML_DIR / "data.json").read_text(encoding="utf-8"))
    generated = [make_listing(rng, fake=False) for _ in range(N_REAL)]
    generated += [make_listing(rng, fake=True) for _ in range(N_FAKE)]
    rng.shuffle(generated)
    return hand_labelled + generated


if __name__ == "__main__":
    listings = generate()
    (ML_DIR / "data2.json").write_text(json.dumps(listings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    fakes = sum(listing["Fake?"] for listing in listings)
    print(f"wrote {len(listings)} listings to ml/data2.json ({len(listings) - fakes} real, {fakes} fake)")
