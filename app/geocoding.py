from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import requests


class Geocoder(Protocol):
    def geocode(self, address: str) -> tuple[float, float]:
        ...


@dataclass
class NominatimGeocoder:
    base_url: str = "https://nominatim.openstreetmap.org/search"
    user_agent: str = "fedex-map-mvp/0.1"
    timeout: int = 20

    def geocode(self, address: str) -> tuple[float, float]:
        params = {
            "q": address,
            "format": "jsonv2",
            "limit": 1,
        }
        headers = {"User-Agent": self.user_agent}
        response = requests.get(self.base_url, params=params, headers=headers, timeout=self.timeout)
        response.raise_for_status()
        results = response.json()
        if not results:
            raise ValueError(f"No geocoding result for: {address}")
        first = results[0]
        return float(first["lat"]), float(first["lon"])
