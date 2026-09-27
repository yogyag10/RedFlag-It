"""Bagged decision trees where each tree looks at one listing behaviour.

A plain BaggingClassifier gives every tree a random slice of the features, so
all the trees tend to pick the single strongest feature. Here each tree is
restricted to the columns for one behaviour (one warning sign, or the price),
and is still trained on its own bootstrap sample of the listings. The
consensus is "fake when at least ``min_fake_votes`` trees vote fake", because
a scam usually shows only one to three of the behaviours.

The column positions come from fraud_model.build_preprocess(): price is the
first column and the ten warning-sign columns (five flags, then five counts)
are the last ten.
"""

import numpy as np
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.tree import DecisionTreeClassifier

WARNING_SIGNS = [
    "deposit_demand",
    "personal_info_request",
    "etransfer_request",
    "high_demand_claim",
    "foreign_payment",
]
TREE_NAMES = WARNING_SIGNS + ["price"]


def behaviour_columns(n_features: int) -> list[np.ndarray]:
    """Column indices for each tree, in TREE_NAMES order."""
    groups = [np.array([n_features - 10 + i, n_features - 5 + i]) for i in range(len(WARNING_SIGNS))]
    groups.append(np.array([0]))
    return groups


class BehaviourTreeEnsemble(ClassifierMixin, BaseEstimator):
    def __init__(self, min_fake_votes=2, max_depth=1, max_samples=0.8, random_state=42):
        self.min_fake_votes = min_fake_votes
        self.max_depth = max_depth
        self.max_samples = max_samples
        self.random_state = random_state

    def fit(self, X, y):
        y = np.asarray(y).astype(bool)
        rng = np.random.RandomState(self.random_state)
        n_rows = X.shape[0]
        self.classes_ = np.array([False, True])
        self.tree_names_ = list(TREE_NAMES)
        self.estimators_, self.estimators_features_ = [], behaviour_columns(X.shape[1])
        for columns in self.estimators_features_:
            sample = rng.choice(n_rows, int(self.max_samples * n_rows), replace=True)
            tree = DecisionTreeClassifier(
                max_depth=self.max_depth, class_weight="balanced", random_state=self.random_state
            )
            self.estimators_.append(tree.fit(X[sample][:, columns], y[sample]))
        return self

    def fake_votes(self, X) -> np.ndarray:
        """How many trees vote fake for each row."""
        return np.sum([
            tree.predict(X[:, columns]).astype(bool)
            for tree, columns in zip(self.estimators_, self.estimators_features_)
        ], axis=0)

    def predict(self, X):
        return self.fake_votes(X) >= self.min_fake_votes

    def predict_proba(self, X):
        """Share of trees voting fake; a vote share, not a calibrated probability."""
        share = self.fake_votes(X) / len(self.estimators_)
        return np.column_stack([1 - share, share])
