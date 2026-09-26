# Vancouver Rental Scam Shield

A Manifest V3 Chrome extension and local FastAPI service for screening rental listings on Craigslist and Facebook Marketplace. It reports explainable warning signs; it does not decide whether a listing is fraudulent.
Im just checking that i can push
## What it does

- Reads the visible listing title, description, price, location coordinates when exposed by the page, and up to eight public image URLs after you click **Analyze this listing**.
- Checks listing language for payment-before-viewing requests, hard-to-reverse payment methods, requests for verification codes, unavailable landlords, and pressure tactics.
- Optionally uses a local OpenCLIP model for image and text embeddings. It can flag a weak text/photo match and compare a photo with recent photos previously analyzed by the same service.
- Optionally stores minimal listing features in PostgreSQL/PostGIS. With enough nearby history, scikit-learn DBSCAN checks for price-and-location density outliers.
- Shows the score and plain-language signal cards in the extension popup. Text-based flags include the short phrase that triggered the rule and where it appeared; each card explains why it matters. The score is a triage aid, not a probability, market valuation, or proof of fraud.

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

Open `http://127.0.0.1:8000/health` to check service status. The base install runs text checks. For optional image and text matching, install `requirements-vision.txt`; OpenCLIP downloads its model weights the first time it analyzes listing photos. Set `RENTSHIELD_DATABASE_URL` to use an existing PostgreSQL/PostGIS database for private listing history, or `RENTSHIELD_API_KEY` to require a bearer token. `RENTSHIELD_CLIP_DEVICE` defaults to `cpu`.

The database has no listing history initially. Geographic price and cross-listing image comparisons become available only after the configured database accumulates analyzed listings. Craigslist coordinates are read where exposed; Facebook pages may not expose coordinates, so location-based checks may be unavailable there.

## Load the extension in Chrome

1. Visit `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository’s `extension` folder.
3. Open a rental listing on Craigslist or Facebook Marketplace, click the extension icon, then click **Analyze this listing**.
4. Use the gear button to change the service URL or add the API key if you changed the local configuration.

The extension requests access only to Craigslist, Facebook Marketplace, and the local API by default. For a remote API, add its URL in Settings and approve Chrome’s host permission prompt. Use HTTPS and a service you control.

## API

`POST /api/analyze` accepts JSON with `title`, `description`, `price`, `currency`, `price_period`, `location_text`, optional `latitude`/`longitude`, `image_urls`, and `source_url`. Image fetches are limited to Craigslist and Facebook media hosts and reject private IP addresses, redirects, non-image content, and images larger than 8 MiB. The popup allows two minutes for a first model load; retry after the initial weights download has completed if needed.

`GET /health` reports service, database configuration, and vision initialization status. `RENTSHIELD_API_KEY` protects analysis requests with `Authorization: Bearer <key>`; local health remains open.

## Data and privacy

- The extension analyzes a page only after the user clicks the button. It does not scrape pages in the background or request account, payment, bank, or financial vendor data.
- The extension sends the visible listing fields and public image URLs to the configured service. The service fetches public photos for local analysis.
- Without `RENTSHIELD_DATABASE_URL`, listing content is processed in memory and not retained by this application.
- With the database enabled, it retains timestamps, asking price/currency/period, optional coordinates, image SHA-256 hashes, perceptual hashes, and CLIP embeddings. It also stores a one-way SHA-256 fingerprint of a source URL to avoid counting repeat checks as separate listings; it does not store the raw URL, listing text, contact details, or image files. The database is empty on first run and is private to the service owner.
- The service URL and API key are stored in Chrome local extension storage. Configure an API key before exposing any service beyond loopback.
- No financial vendor datasets, APIs, or integrations are included.

## Example dataset

`datasets/synthetic_suspicious_listings.json` contains five fully fictional suspicious-listing scenarios for development and demos. It has no real Marketplace content, seller information, addresses, photos, or contact details. The listed `expected_rule_codes` correspond to text rules in the current backend; `manual_review_signals` are review prompts and are not guaranteed automated detections. The synthetic prices are not neighborhood benchmarks, and these examples are not validated training data.

## Project layout

```text
extension/        Manifest V3 extension and popup
backend/app/      FastAPI, rule checks, optional CLIP, PostGIS and DBSCAN
```

## Limits

Listing extraction depends on the marketplaces’ page markup and may miss details. Photo URLs may be blocked by their hosts. A new private database has no comparisons until enough listings have been analyzed; neighborhood price comparisons require coordinates and at least 10 nearby records. Automated signals can be wrong. Verify the address, ownership or rental authority, unit, lease, and payment recipient independently.
