"""Train and use the behaviour-focused bagged decision-stump fraud model.

Based on Bagging.ipynb. Six one-question trees each look at one listing
behaviour (five text warning signs and the price); the listing is called fake
when at least MIN_FAKE_VOTES trees vote fake. See behaviour_ensemble.py.

    Retrain from the backend folder:  python -m ml.fraud_bagging_model

    from ml.fraud_bagging_model import train_model, predict

    train_model()                      # trains on ml/data2.json, saves ml/fraud_bagging_model.joblib
    predict({"title": ..., "description": ..., "price": 1300, ...})
    # -> {"fake": True, "votes": {"fake": 2, "real": 4},
    #     "consensus_rules": ["deposit demand warning sign detected", "price <= 1862 (this listing: 1300)"],
    #     "trees": [{"tree": 1, "name": "deposit_demand", "vote": "fake", "rule": [...]}, ...]}
"""

from functools import lru_cache
from pathlib import Path

import joblib
from sklearn.metrics import f1_score, make_scorer, precision_score, recall_score
from sklearn.model_selection import StratifiedKFold, cross_validate
from sklearn.pipeline import Pipeline

from .behaviour_ensemble import WARNING_SIGNS, BehaviourTreeEnsemble
from .fraud_model import (
    PROJECT_DIR,
    TARGET_COLUMN,
    build_preprocess,
    load_listings,
    parse_listing,
    prepare_features,
    transform_listing,
    tree_rule,
)

# Training data: 500 listings (400 real, 100 fake). data.json holds the earlier 25-listing set.
DATA_PATH = PROJECT_DIR / "data2.json"
MODEL_PATH = PROJECT_DIR / "fraud_bagging_model.joblib"

RANDOM_STATE = 42
CV_FOLDS = 5
MAX_DEPTH = 1  # Each tree is a decision stump: one question
# A scam usually shows one to three behaviours, so a majority of six trees would
# miss most of them. Two agreeing trees keeps false alarms at zero in
# cross-validation while catching most fakes (see README, Fraud model).
MIN_FAKE_VOTES = 2

SCORING = {
    "balanced_accuracy": "balanced_accuracy",
    "fake_precision": make_scorer(precision_score, pos_label=True, zero_division=0),
    "fake_recall": make_scorer(recall_score, pos_label=True, zero_division=0),
    "fake_f1": make_scorer(f1_score, pos_label=True, zero_division=0),
}


def build_model() -> Pipeline:
    """The behaviour-focused bagging pipeline, untrained.

    Each stump sees a bootstrap sample of 80% of the listings and only the
    columns for its own behaviour, so every tree asks about something different.
    """
    ensemble = BehaviourTreeEnsemble(
        min_fake_votes=MIN_FAKE_VOTES, max_depth=MAX_DEPTH, max_samples=0.8,
        random_state=RANDOM_STATE,
    )
    return Pipeline([("preprocess", build_preprocess()), ("ensemble", ensemble)])


def _check_column_layout(model: Pipeline) -> None:
    """The ensemble finds each behaviour by column position; fail loudly if the layout moved."""
    names = list(model.named_steps["preprocess"].get_feature_names_out())
    expected = [f"warning_signs__{sign}" for sign in WARNING_SIGNS]
    expected += [f"warning_signs__{sign}_count" for sign in WARNING_SIGNS]
    if names[0] != "numeric__price" or names[-10:] != expected:
        raise ValueError("Preprocessing column order changed; update behaviour_ensemble.behaviour_columns().")


def train_model(data_path=DATA_PATH, model_path=MODEL_PATH) -> dict:
    """Create, evaluate and train the ensemble, then save it to ``model_path``.

    Reports five-fold cross-validated balanced accuracy and fake-class
    precision, recall and F1 (mean and standard deviation per metric), then
    fits on all listings and saves that model. Returns the metrics.
    """
    data = load_listings(data_path)
    X = prepare_features(data)
    y = data[TARGET_COLUMN].astype(bool)

    cv = StratifiedKFold(n_splits=CV_FOLDS, shuffle=True, random_state=RANDOM_STATE)
    scores = cross_validate(build_model(), X, y, cv=cv, scoring=SCORING)
    metrics = {"rows": len(X)}
    for metric in SCORING:
        fold_scores = scores[f"test_{metric}"]
        metrics[metric] = {
            "folds": fold_scores.round(3).tolist(),
            "mean": round(float(fold_scores.mean()), 3),
            "std": round(float(fold_scores.std()), 3),
        }

    final_model = build_model().fit(X, y)
    _check_column_layout(final_model)
    joblib.dump(final_model, model_path)
    _load_model.cache_clear()
    metrics["model_path"] = str(model_path)
    return metrics


@lru_cache(maxsize=4)
def _load_model(model_path: str) -> Pipeline:
    return joblib.load(model_path)


def predict(listing, model_path=MODEL_PATH) -> dict:
    """Predict whether one listing is fake, using the ensemble saved by ``train_model``.

    ``listing`` is one JSON data point: a dict, or a JSON string of one, in the
    same format as data.json. Returns:

    - ``fake``: the consensus, true when at least ``MIN_FAKE_VOTES`` trees vote fake
    - ``votes``: how many trees voted fake and real
    - ``consensus_rules``: the rules of the trees that agree with the consensus
    - ``trees``: every tree's behaviour name, vote and the rule behind it
    """
    listing = parse_listing(listing)
    model_path = Path(model_path)
    if not model_path.exists():
        raise FileNotFoundError(f"No trained model at {model_path}. Run train_model() first.")

    model = _load_model(str(model_path))
    features, names = transform_listing(model.named_steps["preprocess"], listing)
    ensemble = model.named_steps["ensemble"]

    trees = []
    for number, (tree, feature_indices, tree_name) in enumerate(
        zip(ensemble.estimators_, ensemble.estimators_features_, ensemble.tree_names_), start=1
    ):
        # Each tree was trained on its own behaviour's columns.
        vote, rule = tree_rule(tree, features[feature_indices], names[feature_indices])
        trees.append({"tree": number, "name": tree_name, "vote": "fake" if vote else "real", "rule": rule})

    fake = bool(ensemble.predict(features.reshape(1, -1))[0])
    consensus_vote = "fake" if fake else "real"
    # Trees can ask the same question at slightly different thresholds;
    # keep one condition per question (the text before the numbers in brackets).
    consensus_rules = {}
    for tree in trees:
        if tree["vote"] == consensus_vote:
            for condition in tree["rule"]:
                consensus_rules.setdefault(condition.split(" (")[0], condition)
    fake_votes = sum(tree["vote"] == "fake" for tree in trees)
    return {
        "fake": fake,
        "votes": {"fake": fake_votes, "real": len(trees) - fake_votes},
        "consensus_rules": list(consensus_rules.values()),
        "trees": trees,
    }


if __name__ == "__main__":
    for name, value in train_model().items():
        print(f"{name}: {value}")
