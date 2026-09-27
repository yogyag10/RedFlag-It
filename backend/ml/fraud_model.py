"""Shared preprocessing and rule helpers for the fraud models (from Model.ipynb).

fraud_bagging_model.py builds on this file. The single-tree model here can
also be trained with ``python -m ml.fraud_model``.

    from ml.fraud_model import train_model, predict

    train_model()                      # trains on data.json, saves fraud_model.joblib
    predict({"title": ..., "description": ..., "price": 1300, ...})
    # -> {"fake": True, "rule": ["price <= 1500 (this listing: 1300)", ...]}
"""

import json
from functools import lru_cache
from pathlib import Path

import joblib
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.impute import SimpleImputer
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder
from sklearn.tree import DecisionTreeClassifier

from housing_fraud_nlp import WarningSignFeatures

PROJECT_DIR = Path(__file__).resolve().parent
DATA_PATH = PROJECT_DIR / "data.json"
MODEL_PATH = PROJECT_DIR / "fraud_model.joblib"

RANDOM_STATE = 42
TEST_SIZE = 0.2
MAX_DEPTH = 3  # Small cap keeps the tree readable and limits overfitting
CV_FOLDS = 5

TARGET_COLUMN = "Fake?"
# Location (latitude/longitude) is left out for now; add "lon", "lat" to both lists to use it again.
FEATURE_COLUMNS = ["price", "description", "currency", "price_period", "title"]
NUMERIC_COLUMNS = ["price"]
CATEGORICAL_COLUMNS = ["currency", "price_period"]


def load_listings(json_path=DATA_PATH) -> pd.DataFrame:
    """Read the listings JSON file into a pandas DataFrame."""
    return pd.read_json(json_path, encoding="utf-8")


def prepare_features(data: pd.DataFrame) -> pd.DataFrame:
    """Select the model inputs (longitude/latitude are renamed to lon/lat if present).

    Missing columns are filled with empty values so a partial listing can
    still be scored; the pipeline imputes numbers and treats missing text as empty.
    """
    data = data.rename(columns={"longitude": "lon", "latitude": "lat"})
    return data.reindex(columns=FEATURE_COLUMNS)


def build_preprocess() -> ColumnTransformer:
    """Turn listing columns into the numeric table the trees train on."""
    return ColumnTransformer(
        transformers=[
            ("numeric", SimpleImputer(strategy="median"), NUMERIC_COLUMNS),
            ("categorical", Pipeline([
                ("imputer", SimpleImputer(strategy="most_frequent")),
                ("onehot", OneHotEncoder(handle_unknown="ignore")),
            ]), CATEGORICAL_COLUMNS),
            ("description", TfidfVectorizer(max_features=300, min_df=2), "description"),
            ("title", TfidfVectorizer(max_features=100, min_df=1), "title"),
            ("warning_signs", WarningSignFeatures(), ["title", "description"]),
        ],
        remainder="drop",
    )


def build_model() -> Pipeline:
    """The decision tree pipeline from Model.ipynb, untrained."""
    return Pipeline([
        ("preprocess", build_preprocess()),
        ("tree", DecisionTreeClassifier(
            max_depth=MAX_DEPTH, min_samples_leaf=3, class_weight="balanced",
            random_state=RANDOM_STATE,
        )),
    ])


def train_model(data_path=DATA_PATH, model_path=MODEL_PATH) -> dict:
    """Create, evaluate and train the model, then save it to ``model_path``.

    Reports the held-out test score and five-fold cross-validated balanced
    accuracy, then refits on all listings so the saved model uses every example.
    Returns the evaluation metrics.
    """
    data = load_listings(data_path)
    X = prepare_features(data)
    y = data[TARGET_COLUMN].astype(bool)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=TEST_SIZE, random_state=RANDOM_STATE, stratify=y
    )
    model = build_model().fit(X_train, y_train)
    metrics = {
        "train_rows": len(X_train),
        "test_rows": len(X_test),
        "train_accuracy": model.score(X_train, y_train),
        "test_accuracy": model.score(X_test, y_test),
    }

    cv = StratifiedKFold(n_splits=CV_FOLDS, shuffle=True, random_state=RANDOM_STATE)
    cv_scores = cross_val_score(build_model(), X, y, cv=cv, scoring="balanced_accuracy")
    metrics["cv_balanced_accuracy"] = cv_scores.tolist()
    metrics["cv_mean"] = float(cv_scores.mean())
    metrics["cv_std"] = float(cv_scores.std())

    final_model = build_model().fit(X, y)
    joblib.dump(final_model, model_path)
    _load_model.cache_clear()
    metrics["model_path"] = str(model_path)
    return metrics


@lru_cache(maxsize=4)
def _load_model(model_path: str) -> Pipeline:
    return joblib.load(model_path)


def _describe_condition(feature: str, threshold: float, value: float, went_left: bool) -> str:
    """Turn one tree split into a readable condition, using the listing's own value."""
    group, _, name = feature.partition("__")
    if group == "warning_signs" and name.endswith("_count"):
        label = name.removesuffix("_count").replace("_", " ").replace("etransfer", "e-transfer")
        comparison = "<=" if went_left else ">"
        return f"{label} evidence sentences {comparison} {threshold:g} (this listing: {value:g})"
    if group == "warning_signs":
        label = name.replace("_", " ").replace("etransfer", "e-transfer")
        return f"no {label} warning sign" if went_left else f"{label} warning sign detected"
    if group == "categorical":
        column, _, category = name.partition("_")
        if column == "price" and category.startswith("period_"):
            column, category = "price_period", category.removeprefix("period_")
        return f"{column} is not {category}" if went_left else f"{column} is {category}"
    if group in {"description", "title"}:
        return (f'{group} does not feature the word "{name}"' if went_left
                else f'{group} features the word "{name}" (TF-IDF {value:.3f} > {threshold:.3f})')
    comparison = "<=" if went_left else ">"
    return f"{name} {comparison} {threshold:.6g} (this listing: {value:.6g})"


def parse_listing(listing) -> dict:
    """Accept one listing as a dict or a JSON object string."""
    if isinstance(listing, str):
        listing = json.loads(listing)
    if not isinstance(listing, dict):
        raise TypeError("listing must be a dict or a JSON object string")
    return listing


def transform_listing(preprocess: ColumnTransformer, listing: dict):
    """Run a fitted preprocessing step on one listing; returns (feature row, feature names)."""
    features = preprocess.transform(prepare_features(pd.DataFrame([listing])))
    features = features.toarray() if hasattr(features, "toarray") else features
    return features[0], preprocess.get_feature_names_out()


def tree_rule(tree: DecisionTreeClassifier, features, names) -> tuple[bool, list[str]]:
    """Follow one fitted tree for a feature row; returns (predicts fake, conditions passed)."""
    nodes = tree.tree_
    rule, node = [], 0
    while nodes.children_left[node] != -1:
        feature_index, threshold = nodes.feature[node], nodes.threshold[node]
        value = float(features[feature_index])
        went_left = value <= threshold
        rule.append(_describe_condition(names[feature_index], threshold, value, went_left))
        node = nodes.children_left[node] if went_left else nodes.children_right[node]
    return bool(tree.classes_[nodes.value[node][0].argmax()]), rule


def predict(listing, model_path=MODEL_PATH) -> dict:
    """Predict whether one listing is fake, using the model saved by ``train_model``.

    ``listing`` is one JSON data point: a dict, or a JSON string of one, in the
    same format as data.json. Returns the prediction and the decision-tree rule
    that produced it: every split the listing passed through, in order.
    """
    listing = parse_listing(listing)
    model_path = Path(model_path)
    if not model_path.exists():
        raise FileNotFoundError(f"No trained model at {model_path}. Run train_model() first.")

    model = _load_model(str(model_path))
    features, names = transform_listing(model.named_steps["preprocess"], listing)
    fake, rule = tree_rule(model.named_steps["tree"], features, names)
    return {"fake": fake, "rule": rule}


if __name__ == "__main__":
    for name, value in train_model().items():
        print(f"{name}: {value}")
