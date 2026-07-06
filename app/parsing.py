from __future__ import annotations

import re
import unicodedata
from typing import Any

ADDRESS_RE = re.compile(r"^\s*(?P<house>\d+[A-Za-z0-9\-/]*)\s+(?P<street>.+?)\s*$")
SUPPORTED_CONFIG_KEYS = {"record_path", "address_field", "source_field"}


def _strip_accents(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in normalized if not unicodedata.combining(ch))


def clean_text(text: str) -> str:
    text = _strip_accents(text or "")
    text = re.sub(r"[\.,;:#]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def normalize_house_number(house_number: str) -> str:
    return clean_text(str(house_number)).upper()


def normalize_street_name(street_name: str) -> str:
    return clean_text(str(street_name)).upper()


def normalize_key(house_number: str, street_name: str) -> str:
    return f"{normalize_house_number(house_number)}|{normalize_street_name(street_name)}"


def build_address(house_number: str, street_name: str) -> str:
    return f"{clean_text(str(house_number))} {clean_text(str(street_name))}".strip()


def parse_address_text(text: str) -> tuple[str, str]:
    cleaned = clean_text(text)
    match = ADDRESS_RE.match(cleaned)
    if not match:
        raise ValueError("Could not detect a house number and a street")
    return match.group("house"), match.group("street")


def normalize_instance_config(config: dict[str, Any] | None) -> dict[str, str]:
    if config is None:
        config = {}
    if not isinstance(config, dict):
        raise ValueError("Instance config must be a JSON object")

    unknown_keys = sorted(set(config) - SUPPORTED_CONFIG_KEYS)
    if unknown_keys:
        raise ValueError(f"Unsupported instance config keys: {', '.join(unknown_keys)}")

    normalized: dict[str, str] = {}
    for key in SUPPORTED_CONFIG_KEYS:
        value = config.get(key)
        if value is None:
            continue
        if not isinstance(value, str):
            raise ValueError(f"Instance config field '{key}' must be a string")
        normalized_value = value.strip()
        if normalized_value:
            normalized[key] = normalized_value

    normalized.setdefault("record_path", "records")
    normalized.setdefault("address_field", "text")
    normalized.setdefault("source_field", "source")
    return normalized


def _get_by_path(payload: Any, path: str) -> Any:
    current = payload
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            raise ValueError(f"Could not find record path '{path}' in the JSON payload")
        current = current[part]
    return current


def extract_records(payload: Any, config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    normalized_config = normalize_instance_config(config)
    record_path = normalized_config.get("record_path", "records")

    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict):
        if record_path and record_path in payload and isinstance(payload[record_path], list):
            records = payload[record_path]
        elif record_path and "." in record_path:
            nested_value = _get_by_path(payload, record_path)
            if not isinstance(nested_value, list):
                raise ValueError(f"Record path '{record_path}' must resolve to a list")
            records = nested_value
        elif record_path == "records" and "records" in payload and isinstance(payload["records"], list):
            records = payload["records"]
        else:
            records = [payload]
    else:
        raise ValueError("The JSON must be an object or a list of objects")

    if not all(isinstance(record, dict) for record in records):
        raise ValueError("Every record must be a JSON object")
    return records


def coerce_stop_payload(record: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
    normalized_config = normalize_instance_config(config)
    payload = dict(record)
    address_field = normalized_config.get("address_field", "text")
    source_field = normalized_config.get("source_field", "source")

    if address_field in payload and not payload.get("text") and not payload.get("raw_text"):
        payload["text"] = payload[address_field]
    if source_field in payload and not payload.get("source"):
        payload["source"] = payload[source_field]
    return payload
