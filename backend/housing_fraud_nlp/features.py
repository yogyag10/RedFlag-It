"""scikit-learn transformer that turns listing text into warning-sign features."""

import numpy as np
from sklearn.base import BaseEstimator, TransformerMixin

from .detectors import (
    detect_deposit_demand,
    detect_etransfer_request,
    detect_foreign_payment_destination,
    detect_high_demand_claim,
    detect_personal_information_request,
)

DETECTORS = {
    "deposit_demand": detect_deposit_demand,
    "personal_info_request": detect_personal_information_request,
    "etransfer_request": detect_etransfer_request,
    "high_demand_claim": detect_high_demand_claim,
    "foreign_payment": detect_foreign_payment_destination,
}


def _texts(X) -> list[str]:
    """One text per row. Multiple columns (e.g. title and description) are
    joined with a line break so each stays its own sentence."""
    if hasattr(X, "to_numpy"):
        X = X.to_numpy()
    rows = np.asarray(X, dtype=object)
    if rows.ndim == 1:
        rows = rows.reshape(-1, 1)
    return [
        "\n".join(str(value) for value in row if isinstance(value, str) and value.strip())
        for row in rows
    ]


class WarningSignFeatures(TransformerMixin, BaseEstimator):
    """Run the five warning-sign detectors on each row of text.

    Outputs one 0/1 column per detector and, with ``include_counts``, one
    column per detector with the number of evidence sentences. Stateless:
    ``fit`` learns nothing, so it is safe inside cross-validation.
    """

    def __init__(self, include_counts: bool = True):
        self.include_counts = include_counts

    def fit(self, X, y=None):
        self.n_features_in_ = 1 if np.asarray(X, dtype=object).ndim == 1 else np.shape(X)[1]
        if hasattr(X, "columns"):
            self.feature_names_in_ = np.asarray(X.columns, dtype=object)
        return self

    def transform(self, X):
        features = []
        for text in _texts(X):
            results = [detector(text) for detector in DETECTORS.values()]
            row = [int(result.detected) for result in results]
            if self.include_counts:
                row += [len(result.evidence) for result in results]
            features.append(row)
        return np.asarray(features, dtype=float).reshape(-1, len(self.get_feature_names_out()))

    def get_feature_names_out(self, input_features=None):
        names = list(DETECTORS)
        if self.include_counts:
            names += [f"{name}_count" for name in DETECTORS]
        return np.asarray(names, dtype=object)
