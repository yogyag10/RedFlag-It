"""Price-and-location density checks over this service's own recent history."""

import math

import numpy as np
from sklearn.cluster import DBSCAN
from sklearn.preprocessing import StandardScaler


def is_density_outlier(peers: list[dict], price: float, latitude: float, longitude: float) -> bool:
    if len(peers) < 10 or price <= 0:
        return False
    rows = [(price, latitude, longitude)]
    for peer in peers:
        try:
            value = float(peer["price"])
            lat = float(peer["latitude"])
            lon = float(peer["longitude"])
        except (TypeError, ValueError, KeyError):
            continue
        if value > 0:
            rows.append((value, lat, lon))
    if len(rows) < 11:
        return False

    lat0 = latitude
    x_scale = 111.32 * max(0.15, math.cos(math.radians(lat0)))
    matrix = np.asarray([
        [(lon - longitude) * x_scale, (lat - latitude) * 110.574, math.log(value)]
        for value, lat, lon in rows
    ], dtype=np.float64)
    scaled = StandardScaler().fit_transform(matrix)
    labels = DBSCAN(eps=0.85, min_samples=5).fit_predict(scaled)
    return int(labels[0]) == -1

