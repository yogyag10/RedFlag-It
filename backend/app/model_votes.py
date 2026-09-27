"""Verdict, votes and rules from the trained bagging model (ml/fraud_bagging_model.py).

The rule checks in risk.py still produce the score and evidence. This module
supplies the ``fake``/``votes``/``risk_light``/``consensus_rules``/``trees``
part of the response. If the model file is missing or cannot be loaded, it falls back to
the rule votes so the service keeps working.
"""

from .risk import RiskResult, vote_summary
from .schemas import ListingRequest

try:
    from ml.fraud_bagging_model import MODEL_PATH, predict
    _import_error: Exception | None = None
except Exception as exc:  # spaCy or scikit-learn not installed
    MODEL_PATH, predict = None, None
    _import_error = exc

_reported_failure = False


def model_status() -> str:
    if _import_error is not None:
        return f"unavailable ({type(_import_error).__name__})"
    if not MODEL_PATH.exists():
        return "missing (run: python -m ml.fraud_bagging_model)"
    return "ready"


def _model_input(listing: ListingRequest) -> dict:
    return {
        "title": listing.title,
        "description": listing.description,
        "price": listing.price,
        "currency": listing.currency,
        "price_period": listing.price_period,
    }


RISK_LIGHT_LABELS = {
    "green": "No warning signs found",
    "yellow": "1 warning sign: check before paying",
    "red": "2+ warning signs: high risk",
}


def risk_light(warnings: int) -> dict[str, object]:
    color = "green" if warnings == 0 else "yellow" if warnings == 1 else "red"
    return {"color": color, "warnings": warnings, "label": RISK_LIGHT_LABELS[color]}


def _with_rule_light(summary: dict[str, object]) -> dict[str, object]:
    """Add the light to the rule-vote fallback; 2+ matched rules is red and fake."""
    warnings = summary["votes"]["fake"]
    return {**summary, "fake": warnings >= 2, "risk_light": risk_light(warnings)}


def model_vote_summary(listing: ListingRequest, rules: RiskResult) -> dict[str, object]:
    """Votes from the bagging model; falls back to the rule votes if it is unavailable.

    Each tree string follows the extension's "vote | code | rule" format, for
    example "fake | model_foreign_payment | foreign payment warning sign detected".
    """
    global _reported_failure
    fallback = _with_rule_light(vote_summary(rules))
    if model_status() != "ready":
        return fallback
    try:
        result = predict(_model_input(listing))
    except Exception as exc:
        if not _reported_failure:
            # Do not log listing content.
            print(f"Fraud model prediction failed, using rule votes: {type(exc).__name__}")
            _reported_failure = True
        return fallback

    # Codes name the behaviour each tree checks, e.g. "model_deposit_demand".
    trees = [
        f"{tree['vote']} | model_{tree.get('name') or 'tree_' + str(tree['tree'])} | {'; '.join(tree['rule']) or 'no split'}"
        for tree in result["trees"]
    ]
    # A low price is only a warning alongside a behaviour warning; on its own it
    # stays green (many honest listings are simply cheap).
    behaviour_warnings = sum(
        tree["vote"] == "fake" and tree.get("name") != "price" for tree in result["trees"]
    )
    price_warning = any(
        tree["vote"] == "fake" and tree.get("name") == "price" for tree in result["trees"]
    )
    warnings = behaviour_warnings + (1 if price_warning and behaviour_warnings else 0)
    return {
        "fake": result["fake"],
        "votes": {**result["votes"], "unknown": 0},
        "risk_light": risk_light(warnings),
        "review_check_available": fallback["review_check_available"],
        "consensus_rules": result["consensus_rules"] if result["fake"] else [],
        "trees": trees,
    }
