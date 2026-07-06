from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .geocoding import NominatimGeocoder
from .parsing import extract_records, normalize_instance_config
from .storage import StopRepository

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
DEFAULT_DB_PATH = os.getenv("FEDEX_MAP_DB", str(PROJECT_DIR / "data" / "stops.sqlite3"))


def _read_dotenv_value(name: str, env_path: Path | None = None) -> str:
    env_file = env_path or (PROJECT_DIR / ".env")
    if not env_file.is_file():
        return ""

    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() != name:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'\"', "'"}:
            value = value[1:-1]
        return value
    return ""


def get_google_maps_api_key() -> str:
    return os.getenv("GOOGLE_MAPS_API_KEY", "") or _read_dotenv_value("GOOGLE_MAPS_API_KEY")


DEFAULT_GOOGLE_MAPS_API_KEY = get_google_maps_api_key()


def create_app(db_path: str | None = None, geocoder=None) -> FastAPI:
    repo = StopRepository(db_path or DEFAULT_DB_PATH)
    geocoder = geocoder or NominatimGeocoder()

    app = FastAPI(title="FedEx Map MVP", version="0.1.0")
    templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
    app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
    app.state.repo = repo
    app.state.geocoder = geocoder

    def serialize_instance(request: Request, instance: dict[str, Any]) -> dict[str, Any]:
        return {
            **instance,
            "url_path": f"/i/{instance['slug']}",
            "url": str(request.url_for("instance_page", slug=instance["slug"])),
        }

    def get_instance_or_404(slug: str) -> dict[str, Any]:
        instance = repo.get_instance_by_slug(slug)
        if instance is None:
            raise HTTPException(status_code=404, detail="Instance not found")
        return instance

    @app.get("/", response_class=HTMLResponse)
    def landing_page(request: Request):
        return templates.TemplateResponse(
            request=request,
            name="landing.html",
            context={
                "title": "FedEx Map MVP | Create Instance",
                "google_maps_api_key": get_google_maps_api_key(),
            },
        )

    @app.get("/i/{slug}", name="instance_page", response_class=HTMLResponse)
    def instance_page(request: Request, slug: str):
        instance = repo.get_instance_by_slug(slug)
        if instance is None:
            return templates.TemplateResponse(
                request=request,
                name="not_found.html",
                context={"title": "Instance Not Found", "slug": slug},
                status_code=404,
            )

        return templates.TemplateResponse(
            request=request,
            name="index.html",
            context={
                "title": f"{instance['name']} | FedEx Map MVP",
                "google_maps_api_key": get_google_maps_api_key(),
                "instance": serialize_instance(request, instance),
            },
        )

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.post("/api/instances")
    async def create_instance(request: Request):
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON") from exc

        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="The request body must be a JSON object")

        name = str(payload.get("name") or "").strip()
        slug = payload.get("slug")
        slug = str(slug).strip() if slug is not None else None

        try:
            config = normalize_instance_config(payload.get("config"))
            initial_data = payload.get("initial_data")
            records = None
            if initial_data is not None:
                records = extract_records(initial_data, config)
            instance = repo.create_instance(name=name, slug=slug, config=config)
            ingest_result = (
                repo.bulk_add(instance["id"], records, geocoder, instance["config"])
                if records is not None
                else None
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        return {
            "instance": serialize_instance(request, instance),
            "ingest": ingest_result,
        }

    @app.get("/api/instances/{slug}")
    def get_instance_summary(request: Request, slug: str):
        instance = get_instance_or_404(slug)
        return {"instance": serialize_instance(request, instance)}

    @app.get("/api/instances/{slug}/stops")
    def get_stops(slug: str):
        instance = get_instance_or_404(slug)
        return {"stops": repo.list_stops(instance["id"])}

    @app.delete("/api/instances/{slug}/stops")
    def clear_stops(slug: str):
        instance = get_instance_or_404(slug)
        return {"deleted": repo.clear_stops(instance["id"])}

    @app.delete("/api/instances/{slug}/stops/{stop_id}")
    def delete_stop(slug: str, stop_id: int):
        instance = get_instance_or_404(slug)
        if not repo.delete_stop(instance["id"], stop_id):
            raise HTTPException(status_code=404, detail="Stop not found")
        return {"deleted": 1}

    @app.post("/api/instances/{slug}/stops/clear")
    def clear_stops_post(slug: str):
        instance = get_instance_or_404(slug)
        return {"deleted": repo.clear_stops(instance["id"])}

    @app.post("/api/instances/{slug}/stops")
    def add_stop(slug: str, payload: dict[str, Any]):
        instance = get_instance_or_404(slug)
        if payload.get("action") == "clear":
            return {"deleted": repo.clear_stops(instance["id"])}
        try:
            result = repo.add_stop(instance["id"], payload, geocoder, instance["config"])
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return result

    @app.post("/api/instances/{slug}/stops/bulk")
    def add_stops_bulk(slug: str, payload: dict[str, Any]):
        instance = get_instance_or_404(slug)
        try:
            records = extract_records(payload, instance["config"])
            result = repo.bulk_add(instance["id"], records, geocoder, instance["config"])
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return result

    @app.post("/api/instances/{slug}/ingest-json")
    async def ingest_json(request: Request, slug: str):
        instance = get_instance_or_404(slug)
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON") from exc

        try:
            records = extract_records(payload, instance["config"])
            return repo.bulk_add(instance["id"], records, geocoder, instance["config"])
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return app


app = create_app()
