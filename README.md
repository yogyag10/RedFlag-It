# RedFlag

A Manifest V3 Chrome extension and local FastAPI service for screening rental listings on Craigslist, Facebook Marketplace, and Furnished Finder. It reports explainable warning signs; it does not decide whether a listing is fraudulent.
## What it does

- Adds a lightweight text-score bubble to visible rental search results. Opening a single Craigslist, Facebook Marketplace, or Furnished Finder listing runs its full check and shows a RedFlag bubble with that listing's score; select **See details** for evidence. The extension reads the listing page DOM and does not use marketplace cookies.
- On a result card, only the visible title and short card text are sent to `/api/quick-scores`. Opening an individual listing sends its visible text, details, source URL, and up to eight public photo links to `/api/analyze`. Explicitly labeled room options can receive separate results; ambiguous room counts are not split into invented options.
- Checks listing language for payment-before-viewing requests, hard-to-reverse payment methods, requests for verification codes, unavailable landlords, and pressure tactics. When a public profile rating and at least five reviews are visible, it also flags ratings of 2.5/5 or lower for manual review.
- Optionally uses a local OpenCLIP model for image and text matching, photo reuse checks, and a likely-visible furniture estimate. Furniture matching is a semantic photo estimate, not object detection or proof that an item is included.
- Optionally stores minimal listing features in PostgreSQL/PostGIS. With enough nearby history, scikit-learn DBSCAN checks for price-and-location density outliers.
- Shows a traffic light for each checked listing: green (no red flags), yellow (one red flag: check before paying) or red (two or more: high risk), from the fraud model's `risk_light`. **See details** lists only the red flags, the checks the listing failed, with the rule-based score as a secondary line. A low price is listed only alongside another red flag.
- Keeps up to five recent checks in Chrome storage on this device. History contains the listing title, results, and short evidence excerpts; it omits the structured address field, listing URL, photo links, and full description. The score is a triage aid, not a probability, market valuation, or proof of fraud.

Risk bands are 0–29 (**LOW RISK**), 30–59 (**BE CAREFUL**), and 60–100 (**SCAM POSSIBLE**). The percentage is a rule-based screening score, not a calibrated chance of fraud.

The project uses OpenCLIP with LAION pretrained weights. It does not send listing content to OpenAI or another model API. CLIP weights are downloaded by the vision-enabled service on its first model use.

## Run the local service

Run the API directly with Python. It binds to loopback, so it is available only on your computer by default.

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/health` to check service status. The base install runs text checks. To enable photo matching and furniture estimates, install `requirements-vision.txt`; OpenCLIP downloads its model weights the first time it analyzes listing photos. Set `RENTSHIELD_DATABASE_URL` to use an existing PostgreSQL/PostGIS database for private listing history, or `RENTSHIELD_API_KEY` to require a bearer token. `RENTSHIELD_CLIP_DEVICE` defaults to `cpu`.

The database has no listing history initially. Geographic price and cross-listing image comparisons become available only after the configured database accumulates analyzed listings. Craigslist coordinates are read where exposed; Facebook pages may not expose coordinates, so location-based checks may be unavailable there.

## Load the extension in Chrome

1. Visit `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository’s `extension` folder.
3. Open a rental search on Craigslist, Facebook Marketplace, or Furnished Finder. RedFlag adds quick-score bubbles to result cards. Open a result to see its full check bubble and select **See details** for evidence.
4. Use the gear button to change the service URL or add the API key if you changed the local configuration.

To refresh changes, click the reload icon for RedFlag at `chrome://extensions`, then reload the rental listing tab. Restart Uvicorn after backend changes. `http://127.0.0.1:8000/health` checks that the service is responding.

The extension requests access only to Craigslist, Facebook Marketplace, Furnished Finder, and the local API by default. For a remote API, add its URL in Settings and approve Chrome’s host permission prompt. Use HTTPS and a service you control.

## API

`POST /api/quick-scores` accepts up to 20 `{id, title, description, photo_available}` card summaries and returns lightweight text-warning scores without adding points for fields that search cards do not show. These quick scores do not save listings or download photos. The full `/api/analyze` check accepts `title`, `description`, `bedrooms`, `bathrooms`, `address`, `price`, `currency`, `price_period`, `location_text`, `latitude`, `longitude`, `image_urls`, and `source_url`, plus optional `rooms`, `profile_facts`, `listing_age`, and `availability_text`. Its JSON response includes `fake`, `votes` (`fake`/`real`/`unknown` counts), `risk_light`, `review_check_available`, `consensus_rules`, and `trees` alongside the existing score and evidence fields. `risk_light` is a traffic-light summary: `color` is `green` (no warning signs), `yellow` (one) or `red` (two or more), with the `warnings` count and a display `label`. A low price counts as a warning only alongside another warning sign, so a cheap listing with no other warning stays green; `red` always matches `fake: true`. It also reports `photo_urls_received` and `photos_processed` to distinguish links read by the extension from images fetched by the service. `fake`, `votes`, `consensus_rules`, and `trees` come from the trained fraud model (see **Fraud model** below): each of its six behaviour trees contributes one `"vote | model_<behaviour> | rule"` string, `fake` is the model's consensus (at least two trees voting fake), and `consensus_rules` lists the rules of the trees that voted fake (empty when the consensus is not fake). If the model file is missing or cannot load, these fields fall back to six rule checks (five text rules and a public-review check, where a rating of 2.5/5 or lower from at least five reviews triggers a warning). Neither value verifies whether a listing is genuine. Scores are points out of 100, not percentages or scam probabilities. Explicit room options receive separate scores and model votes. Photo furnishing estimates use local CLIP semantic comparisons when the model and public photos are available; otherwise the response explains that the photo check is unavailable. Image fetches are limited to Craigslist, Facebook, and Furnished Finder media hosts, validate each of up to three redirects, reject private IP addresses and non-image content, and cap image size at 8 MiB. Unavailable numeric or address values are `null`; text values default to empty strings and `image_urls` to an empty array. The first local model load may take longer than later checks.

```json
{
  "fake": true,
  "votes": { "fake": 2, "real": 4, "unknown": 0 },
  "risk_light": { "color": "red", "warnings": 2, "label": "2+ warning signs: high risk" },
  "review_check_available": false,
  "consensus_rules": [
    "personal info request warning sign detected",
    "price <= 1862.5 (this listing: 1700)"
  ],
  "trees": [
    "real | model_deposit_demand | no deposit demand warning sign",
    "fake | model_personal_info_request | personal info request warning sign detected",
    "real | model_etransfer_request | no etransfer request warning sign",
    "real | model_high_demand_claim | no high demand claim warning sign",
    "real | model_foreign_payment | no foreign payment warning sign",
    "fake | model_price | price <= 1862.5 (this listing: 1700)"
  ]
}
```

`GET /health` reports service, database configuration, vision initialization, and fraud model status (`ready`, `missing`, or `unavailable`). `RENTSHIELD_API_KEY` protects analysis requests with `Authorization: Bearer <key>`; local health remains open.

## Fraud model

`backend/ml/fraud_bagging_model.py` is a behaviour-focused version of the bagged decision-stump model from the HelloHacks `Bagging.ipynb` notebook. It has six one-question decision trees, and each tree looks at one listing behaviour and is trained on its own bootstrap sample of 80% of the listings (`backend/ml/behaviour_ensemble.py`):

| Tree code | Behaviour |
|---|---|
| `model_deposit_demand` | asked to send a deposit or payment to reserve the unit |
| `model_personal_info_request` | asked for ID, SIN, banking details or a verification code |
| `model_etransfer_request` | asked to pay by e-transfer or wire |
| `model_high_demand_claim` | "many people interested", "won't last" pressure |
| `model_foreign_payment` | money sent to a person or account outside Canada |
| `model_price` | rent lower than similar listings |

The five behaviour signals come from the rule-based spaCy detectors in `backend/housing_fraud_nlp`. A listing is called fake when **at least two trees** vote fake: a scam usually shows only one to three of these behaviours, so a majority vote would miss most scams, while two agreeing trees kept false alarms at zero in cross-validation.

The trained model is `backend/ml/fraud_bagging_model.joblib`, saved with scikit-learn 1.9. It is trained on `backend/ml/data2.json`: 500 labelled listings (400 real, 100 fake). These are the 25 hand-labelled listings in `backend/ml/data.json` (20 real Facebook Marketplace listings and 5 written scam examples) plus 475 generated by `backend/ml/generate_data2.py`. Generated real and fake listings share titles, neighbourhoods, features, writing style and overlapping prices; fakes add scam behaviour from the RCMP BC guidance, and some real listings mention deposits and e-transfer in the normal way. Regenerate the data or retrain, then restart Uvicorn:

```sh
cd backend
python -m ml.generate_data2      # rewrite ml/data2.json
python -m ml.fraud_bagging_model # retrain and save the model
```

Training prints five-fold cross-validated metrics. Current results: balanced accuracy 0.855, fake precision 1.00, fake recall 0.71 (the earlier version, where five randomly-featured trees all chose the deposit signal, had 0.78, 1.00 and 0.56). Trained on the generated listings only and tested on the 25 hand-labelled ones, it catches 5 of 5 written scams and flags none of the 20 real listings. Scams that show only one behaviour are usually not called fake by the model; the rule checks and score still report them.

## Data and privacy

- On supported search and listing pages, the extension automatically analyzes visible result-card text and the opened listing. It does not run a crawler or visit listings you did not open. It reads the page rendered in your browser; it does not send browser cookies or request account, payment, bank, or financial-vendor data.
- Search-card checks send only the card title and short visible text to the configured service. Opening a listing also sends its visible listing fields and public photo URLs. The service may fetch public photos without the Facebook login session; Facebook can block these requests. It does not send the seller's name or session cookies.
- Without `RENTSHIELD_DATABASE_URL`, listing content is processed in memory and not retained by this application.
- With the database enabled, it retains timestamps, asking price/currency/period, optional coordinates, image SHA-256 hashes, perceptual hashes, and CLIP embeddings. It also stores a one-way SHA-256 fingerprint of a source URL to avoid counting repeat checks as separate listings; it does not store the raw URL, listing text, contact details, or image files. The database is empty on first run and is private to the service owner.
- The service URL and API key are stored in Chrome local extension storage. Configure an API key before exposing any service beyond loopback.
- No financial vendor datasets, APIs, or integrations are included.
- `backend/ml/data.json` and `data2.json` (model training data) contain the text of 20 public Facebook Marketplace rental listings, with one advertiser's name and phone number redacted, plus written and generated examples.

## Example dataset

`datasets/synthetic_suspicious_listings.json` contains five fully fictional suspicious-listing scenarios for development and demos. It has no real Marketplace content, seller information, addresses, photos, or contact details. The listed `expected_rule_codes` correspond to text rules in the current backend; `manual_review_signals` are review prompts and are not guaranteed automated detections. The synthetic prices are not neighborhood benchmarks, and these examples are not validated training data.

## Project layout

```text
extension/                 Manifest V3 extension and popup
backend/app/               FastAPI, rule checks, optional CLIP, PostGIS and DBSCAN
backend/ml/                Trained bagging fraud model, its training code and data
backend/housing_fraud_nlp/ spaCy warning-sign detectors used as model features
```

## Limits

Listing extraction depends on the marketplaces’ page markup and may miss details. Photo URLs may be blocked by their hosts. A new private database has no comparisons until enough listings have been analyzed; neighborhood price comparisons require coordinates and at least 10 nearby records. Automated signals can be wrong. Verify the address, ownership or rental authority, unit, lease, and payment recipient independently.
