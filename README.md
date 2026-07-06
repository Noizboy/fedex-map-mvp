# FedEx Map MVP

Lightweight web application for creating route instances, loading stops from JSON, deduplicating them per instance, geocoding them, and displaying them on a map.

## What this project is for

This project allows you to:

- Create a working instance for each route or delivery group.
- Import addresses from JSON using a simple mapping configuration.
- Avoid duplicates within each instance.
- Geocode addresses to get latitude and longitude.
- Display stops in a web interface using Google Maps.
- Keep each instance isolated under its own URL.

Example use case:

- An operation creates an instance such as `orlando-am`.
- It uploads or pastes a JSON payload with addresses.
- The system normalizes, geocodes, and stores the stops.
- It then shows those stops on the map for that instance.

## Technologies

- Python
- FastAPI
- Uvicorn
- Jinja2
- SQLite
- Google Maps JavaScript API

## Requirements

- Python 3.10 or higher
- A Google Maps API key

## Installation

1. Clone this repository.
2. Create a virtual environment.
3. Install dependencies.
4. Configure environment variables.

### 1. Clone the repository

```bash
git clone <REPOSITORY_URL>
cd fedex-map-mvp
```

### 2. Create a virtual environment

On Linux or macOS:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

On Windows:

```bash
python -m venv .venv
.venv\Scripts\activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Configure environment variables

Create a `.env` file in the project root with this content:

```env
GOOGLE_MAPS_API_KEY="your_api_key_here"
FEDEX_MAP_DB="data/stops.sqlite3"
```

Variables:

- `GOOGLE_MAPS_API_KEY`: key used to load Google Maps in the interface.
- `FEDEX_MAP_DB`: path to the SQLite file used by the application.

If you do not define `GOOGLE_MAPS_API_KEY`, the interface can still load, but the map will not render.

## Run the project

Start the server with:

```bash
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Then open:

```txt
http://localhost:8000
```

## Main flow

1. Open `/`.
2. Create a new instance.
3. The system redirects to `/i/{slug}`.
4. From that instance you can add, import, delete, or clear stops.
5. All operations remain isolated per instance.

## Main API

### Health check

```http
GET /api/health
```

### Create instance

```http
POST /api/instances
```

Example request body:

```json
{
  "name": "FedEx Orlando AM",
  "slug": "orlando-am",
  "config": {
    "record_path": "records",
    "address_field": "text",
    "source_field": "source"
  },
  "initial_data": {
    "records": [
      {"text": "124 W Sample Rd", "source": "json"}
    ]
  }
}
```

### Get an instance

```http
GET /api/instances/{slug}
```

### Get stops for an instance

```http
GET /api/instances/{slug}/stops
```

## JSON import configuration

Each instance can define a simple configuration to read different JSON shapes:

- `record_path`: path to the list of records. Example: `records` or `payload.items`.
- `address_field`: field used as the address source. Example: `text` or `address`.
- `source_field`: field used as the source value.

Example:

```json
{
  "config": {
    "record_path": "payload.items",
    "address_field": "address",
    "source_field": "kind"
  },
  "initial_data": {
    "payload": {
      "items": [
        {"address": "10 Main St", "kind": "dispatch"}
      ]
    }
  }
}
```

## Database

The project uses SQLite by default and stores data at:

```txt
data/stops.sqlite3
```

If you deploy it on a server, you need persistent storage so the data is not lost.

## Tests

To run tests:

```bash
pytest -q
```

## Getting a Google Maps API key

1. Go to Google Cloud Console.
2. Create or select a project.
3. Enable `Maps JavaScript API`.
4. Create an API key.
5. Restrict the key by domain or IP depending on the environment.

## Deployment

For production, remember to configure:

- `GOOGLE_MAPS_API_KEY`
- `FEDEX_MAP_DB`
- a persistent volume for the SQLite database
- the service port

A useful endpoint for monitoring is:

```txt
/api/health
```
