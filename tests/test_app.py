from fastapi.testclient import TestClient

import app.main as main_module
from app.main import create_app
from app.parsing import extract_records, normalize_instance_config, normalize_key, parse_address_text
from app.storage import StopRepository


class FakeGeocoder:
    def geocode(self, address: str):
        if address == "124 W Sample Rd":
            return 28.2919, -81.4079
        return 28.0, -81.0


def create_test_client(tmp_path, monkeypatch=None):
    if monkeypatch is not None:
        monkeypatch.setattr(main_module, "DEFAULT_GOOGLE_MAPS_API_KEY", "test-key")
        monkeypatch.setattr(main_module, "get_google_maps_api_key", lambda: "test-key")
    app = create_app(db_path=str(tmp_path / "stops.sqlite3"), geocoder=FakeGeocoder())
    return TestClient(app)


def create_instance(client: TestClient, **payload):
    body = {"name": "FedEx Orlando AM", **payload}
    response = client.post("/api/instances", json=body)
    assert response.status_code == 200, response.text
    return response.json()["instance"]


def test_parse_address_text():
    house, street = parse_address_text("124 W Sample Rd")
    assert house == "124"
    assert street == "W Sample Rd"


def test_normalize_key():
    assert normalize_key("124", "W Sample Rd") == "124|W SAMPLE RD"


def test_repository_creates_and_lists_instances(tmp_path):
    repo = StopRepository(str(tmp_path / "stops.sqlite3"))

    first = repo.create_instance("FedEx Orlando AM")
    second = repo.create_instance(
        "FedEx Orlando AM",
        config={"record_path": "items", "address_field": "address"},
    )

    assert first["slug"] == "fedex-orlando-am"
    assert second["slug"] == "fedex-orlando-am-2"
    assert second["config"]["record_path"] == "items"
    assert len(repo.list_instances()) == 2
    assert repo.get_instance_by_slug(second["slug"])["name"] == "FedEx Orlando AM"


def test_instance_scoped_dedupes_allow_same_address_in_two_instances(tmp_path):
    repo = StopRepository(str(tmp_path / "stops.sqlite3"))
    first = repo.create_instance("First")
    second = repo.create_instance("Second")

    result_one = repo.add_stop(first["id"], {"text": "124 W Sample Rd"}, FakeGeocoder())
    result_two = repo.add_stop(first["id"], {"text": "124 W Sample Rd"}, FakeGeocoder())
    result_three = repo.add_stop(second["id"], {"text": "124 W Sample Rd"}, FakeGeocoder())

    assert result_one["created"] is True
    assert result_two["created"] is False
    assert result_three["created"] is True
    assert len(repo.list_stops(first["id"])) == 1
    assert len(repo.list_stops(second["id"])) == 1


def test_root_renders_landing_page(tmp_path, monkeypatch):
    client = create_test_client(tmp_path, monkeypatch)

    response = client.get("/")

    assert response.status_code == 200
    assert "Create your own route instance" in response.text
    assert 'pageType: "landing"' in response.text


def test_instance_page_injects_google_maps_and_instance_context(tmp_path, monkeypatch):
    client = create_test_client(tmp_path, monkeypatch)
    instance = create_instance(client, slug="orlando-am")

    response = client.get(f"/i/{instance['slug']}")

    assert response.status_code == 200
    assert "window.APP_CONFIG" in response.text
    assert 'pageType: "instance"' in response.text
    assert "orlando-am" in response.text
    assert "test-key" in response.text
    assert "leaflet" not in response.text.lower()


def test_google_maps_api_key_can_be_loaded_from_dotenv(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text('GOOGLE_MAPS_API_KEY=dotenv-test-key\n', encoding="utf-8")
    monkeypatch.delenv("GOOGLE_MAPS_API_KEY", raising=False)
    monkeypatch.setattr(main_module, "PROJECT_DIR", tmp_path)

    app = create_app(db_path=str(tmp_path / "stops.sqlite3"), geocoder=FakeGeocoder())
    client = TestClient(app)
    instance = create_instance(client)

    response = client.get(f"/i/{instance['slug']}")

    assert response.status_code == 200
    assert "dotenv-test-key" in response.text


def test_create_instance_returns_summary_and_unique_slug(tmp_path):
    client = create_test_client(tmp_path)

    first = client.post("/api/instances", json={"name": "FedEx Orlando AM", "slug": "My Route"})
    second = client.post("/api/instances", json={"name": "FedEx Orlando AM", "slug": "My Route"})

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["instance"]["slug"] == "my-route"
    assert second.json()["instance"]["slug"] == "my-route-2"
    assert second.json()["instance"]["url_path"] == "/i/my-route-2"


def test_stop_routes_are_scoped_by_instance(tmp_path):
    client = create_test_client(tmp_path)
    first = create_instance(client, slug="first")
    second = create_instance(client, slug="second")

    add_one = client.post(f"/api/instances/{first['slug']}/stops", json={"text": "10 Main St"})
    add_two = client.post(f"/api/instances/{second['slug']}/stops", json={"text": "11 Main St"})

    assert add_one.status_code == 200
    assert add_two.status_code == 200
    assert len(client.get(f"/api/instances/{first['slug']}/stops").json()["stops"]) == 1
    assert len(client.get(f"/api/instances/{second['slug']}/stops").json()["stops"]) == 1

    first_stop_id = client.get(f"/api/instances/{first['slug']}/stops").json()["stops"][0]["id"]
    delete_response = client.delete(f"/api/instances/{second['slug']}/stops/{first_stop_id}")
    assert delete_response.status_code == 404
    assert len(client.get(f"/api/instances/{first['slug']}/stops").json()["stops"]) == 1


def test_create_instance_with_initial_data_populates_map(tmp_path):
    client = create_test_client(tmp_path)

    response = client.post(
        "/api/instances",
        json={
            "name": "Populated",
            "initial_data": {"records": [{"text": "10 Main St"}, {"text": "11 Main St"}]},
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["ingest"]["created"] == 2
    stops = client.get(f"/api/instances/{data['instance']['slug']}/stops").json()["stops"]
    assert len(stops) == 2


def test_bulk_ingest_counts_duplicates_per_instance(tmp_path):
    client = create_test_client(tmp_path)
    instance = create_instance(client, slug="bulk-test")

    payload = {
        "records": [
            {"text": "10 Main St"},
            {"text": "10 Main St"},
            {"text": "11 Main St"},
        ]
    }
    response = client.post(f"/api/instances/{instance['slug']}/ingest-json", json=payload)

    assert response.status_code == 200
    data = response.json()
    assert data["created"] == 2
    assert data["duplicates"] == 1


def test_instance_config_is_persisted_and_summary_is_available(tmp_path):
    client = create_test_client(tmp_path)
    config = {"record_path": "payload.items", "address_field": "address", "source_field": "kind"}
    instance = create_instance(client, slug="configurable", config=config)

    response = client.get(f"/api/instances/{instance['slug']}")

    assert response.status_code == 200
    data = response.json()["instance"]
    assert data["slug"] == "configurable"
    assert data["config"] == config
    assert data["url_path"] == "/i/configurable"


def test_instance_config_mapping_is_used_during_ingest(tmp_path):
    client = create_test_client(tmp_path)
    instance = create_instance(
        client,
        slug="mapped",
        config={"record_path": "payload.items", "address_field": "address", "source_field": "kind"},
    )

    response = client.post(
        f"/api/instances/{instance['slug']}/ingest-json",
        json={
            "payload": {
                "items": [
                    {"address": "10 Main St", "kind": "dispatch"},
                    {"address": "11 Main St", "kind": "dispatch"},
                ]
            }
        },
    )

    assert response.status_code == 200
    stops = client.get(f"/api/instances/{instance['slug']}/stops").json()["stops"]
    assert len(stops) == 2
    assert stops[0]["source"] == "dispatch"


def test_invalid_instance_handling_is_route_specific(tmp_path):
    client = create_test_client(tmp_path)

    html_response = client.get("/i/missing-instance")
    api_response = client.get("/api/instances/missing-instance/stops")

    assert html_response.status_code == 404
    assert "Instance not found" in html_response.text
    assert api_response.status_code == 404
    assert api_response.json()["detail"] == "Instance not found"


def test_clear_and_delete_routes_only_affect_active_instance(tmp_path):
    client = create_test_client(tmp_path)
    first = create_instance(client, slug="first")
    second = create_instance(client, slug="second")

    client.post(f"/api/instances/{first['slug']}/ingest-json", json={"records": [{"text": "10 Main St"}, {"text": "11 Main St"}]})
    client.post(f"/api/instances/{second['slug']}/ingest-json", json={"records": [{"text": "12 Main St"}]})

    clear_response = client.delete(f"/api/instances/{first['slug']}/stops")
    assert clear_response.status_code == 200
    assert clear_response.json()["deleted"] == 2
    assert client.get(f"/api/instances/{first['slug']}/stops").json()["stops"] == []
    assert len(client.get(f"/api/instances/{second['slug']}/stops").json()["stops"]) == 1


def test_normalize_instance_config_and_extract_records_support_custom_shapes():
    config = normalize_instance_config({"record_path": "payload.items", "address_field": "address"})
    records = extract_records(
        {"payload": {"items": [{"address": "10 Main St"}, {"address": "11 Main St"}]}},
        config,
    )

    assert config["source_field"] == "source"
    assert len(records) == 2
