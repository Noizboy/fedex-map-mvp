# Instance Multi-Tenant Loop Engineering Tasks

Use this checklist as a loop-engineering queue. Each loop should:

1. Pick exactly one unchecked task.
2. Define the expected outcome before editing.
3. Make the smallest safe change.
4. Run the listed verification commands.
5. Mark the task as completed only after verification passes or the remaining risk is documented.

---

## Tasks

### INST-001. Add instance domain model and storage primitives

- [x] **Status:** Completed
- **Priority:** High
- **Depends on:** None
- **Files to touch:** `app/storage.py`, `tests/test_app.py`
- **Problem:** The repository currently stores all stops in a single global dataset. There is no concept of instance ownership, instance metadata, or isolated storage.
- **Expected outcome:** The storage layer can create, fetch, and list instances, and the schema supports associating stops with an `instance_id`.
- **Done when:** SQLite schema includes an `instances` table, `stops` records are instance-scoped, and repository methods exist for instance CRUD needed by the MVP.
- **Verification:**
  ```bash
  pytest -q
  ```
- **Risk / notes:** Existing uniqueness on `normalized_key` must change to instance-scoped uniqueness so two instances can ingest the same address without collisions.

### INST-002. Scope stop operations by instance

- [x] **Status:** Completed
- **Priority:** High
- **Depends on:** INST-001
- **Files to touch:** `app/storage.py`, `app/main.py`, `tests/test_app.py`
- **Problem:** Current stop endpoints read and mutate one shared pool of stops, which breaks the core requirement that each user has their own instance link and their own data.
- **Expected outcome:** All stop reads, writes, deletes, and bulk ingests require an instance context and only affect that instance.
- **Done when:** Backend stop operations filter by `instance_id`, and tests prove two instances do not see or delete each other's stops.
- **Verification:**
  ```bash
  pytest -q
  ```
- **Risk / notes:** Keep the change minimal by threading `instance_id` through existing repository methods instead of rewriting the whole repository structure.

### INST-003. Add instance creation endpoint and slug generation

- [x] **Status:** Completed
- **Priority:** High
- **Depends on:** INST-001
- **Files to touch:** `app/main.py`, `app/storage.py`, `tests/test_app.py`
- **Problem:** There is no backend entry point for creating a reusable instance URL.
- **Expected outcome:** Backend exposes a `POST /api/instances` endpoint that creates an instance, validates input, generates or normalizes a unique slug, and returns the instance URL metadata.
- **Done when:** A client can create an instance with a name and receive a durable slug plus link target.
- **Verification:**
  ```bash
  pytest -q
  ```
- **Risk / notes:** Prefer server-side slug generation with collision handling. Avoid making the slug the only secret if private access is required later.

### INST-004. Split landing page from instance application page

- [x] **Status:** Completed
- **Priority:** High
- **Depends on:** INST-003
- **Files to touch:** `app/main.py`, `app/templates/index.html`, `app/templates/landing.html`, `tests/test_app.py`
- **Problem:** The root route currently opens the operational map directly, but the desired flow starts with a page for creating a personal instance.
- **Expected outcome:** `/` becomes a landing/create-instance page, and the map application is rendered from `/i/{slug}`.
- **Done when:** Root route shows creation UX and valid instance routes render the current app experience.
- **Verification:**
  ```bash
  pytest -q
  ```
- **Risk / notes:** Minimal migration path is to rename the current template conceptually into an instance page and add a new landing template.

### INST-005. Inject instance context into the frontend

- [x] **Status:** Completed
- **Priority:** High
- **Depends on:** INST-004
- **Files to touch:** `app/main.py`, `app/templates/index.html`, `app/static/app.js`, `tests/test_app.py`
- **Problem:** Frontend JavaScript currently calls global endpoints like `/api/stops` and has no awareness of the active instance slug.
- **Expected outcome:** The rendered page injects `instanceSlug` or equivalent config, and frontend requests are routed through instance-scoped API URLs.
- **Done when:** Loading `/i/{slug}` causes all fetches to resolve against that instance only.
- **Verification:**
  ```bash
  pytest -q
  ```
- **Risk / notes:** Keep URL building centralized in the frontend to avoid scattered hardcoded endpoint strings.

### INST-006. Add landing form for instance creation and redirect flow

- [x] **Status:** Completed
- **Priority:** Medium
- **Depends on:** INST-004
- **Files to touch:** `app/templates/landing.html`, `app/static/style.css`, `app/static/app.js`, `tests/test_app.py`
- **Problem:** Even after backend support exists, users still need a first-run experience to create their own instance without manual API calls.
- **Expected outcome:** Landing page includes a simple form for instance name, optional slug, and optional initial JSON, then redirects to the instance URL after creation.
- **Done when:** A new user can create an instance from the browser without using external tools.
- **Verification:**
  ```bash
  pytest -q
  ```
- **Risk / notes:** Keep the form small in the MVP. Advanced configuration can be deferred to a later task.

### INST-007. Support initial JSON ingestion during instance creation

- [x] **Status:** Completed
- **Priority:** Medium
- **Depends on:** INST-002, INST-006
- **Files to touch:** `app/main.py`, `app/storage.py`, `app/static/app.js`, `tests/test_app.py`
- **Problem:** The requested onboarding flow includes uploading a user's own JSON as part of instance setup.
- **Expected outcome:** The create-instance flow can optionally ingest an initial payload immediately after instance creation, with proper validation and per-instance storage.
- **Done when:** A user can create an instance with initial data and land on a populated map.
- **Verification:**
  ```bash
  pytest -q
  ```
- **Risk / notes:** Keep ingest synchronous for the MVP unless performance becomes an issue with large payloads.

### INST-008. Persist per-instance configuration for custom logic

- [x] **Status:** Completed
- **Priority:** High
- **Depends on:** INST-001, INST-003
- **Files to touch:** `app/storage.py`, `app/main.py`, `tests/test_app.py`
- **Problem:** The requirement says each user should have their own system logic, but the app currently has one shared parsing and ingest behavior.
- **Expected outcome:** Instances store a `config_json` or equivalent configuration block that can express per-instance input mapping and processing rules.
- **Done when:** Instance creation and retrieval include persisted configuration, even if only a small subset of logic is honored at first.
- **Verification:**
  ```bash
  pytest -q
  ```
- **Risk / notes:** Do not execute arbitrary uploaded code in-process. Model custom logic as validated configuration rules for the MVP.

### INST-009. Apply configurable input mapping during ingest

- [x] **Status:** Completed
- **Priority:** Medium
- **Depends on:** INST-007, INST-008
- **Files to touch:** `app/main.py`, `app/parsing.py`, `app/storage.py`, `tests/test_app.py`
- **Problem:** Saving per-instance configuration is not enough if ingestion still assumes one fixed payload shape like `{ "records": [...] }` and one fixed address field.
- **Expected outcome:** Ingest logic reads a limited set of instance-specific mapping rules such as record path, address field name, and source field name.
- **Done when:** At least two different payload shapes can be ingested correctly depending on instance configuration.
- **Verification:**
  ```bash
  pytest -q
  ```
- **Risk / notes:** Keep the supported config surface narrow and explicit. Add capabilities incrementally instead of building a full DSL in one loop.

### INST-010. Add instance summary endpoint and shareable metadata

- [x] **Status:** Completed
- **Priority:** Medium
- **Depends on:** INST-003
- **Files to touch:** `app/main.py`, `app/storage.py`, `tests/test_app.py`
- **Problem:** The frontend and future integrations need a clean way to retrieve instance metadata, configuration, and link details.
- **Expected outcome:** Backend exposes an instance detail endpoint for the active slug with basic metadata required by the UI.
- **Done when:** The frontend can fetch instance metadata without relying on HTML-only bootstrap data.
- **Verification:**
  ```bash
  pytest -q
  ```
- **Risk / notes:** Keep the response small and avoid exposing internal-only fields unless needed.

### INST-011. Add invalid-instance handling and not-found UX

- [x] **Status:** Completed
- **Priority:** Medium
- **Depends on:** INST-004
- **Files to touch:** `app/main.py`, `app/templates/not_found.html`, `tests/test_app.py`
- **Problem:** Instance routes will need a safe and understandable response when a slug does not exist.
- **Expected outcome:** Nonexistent slugs return a clear 404 page or JSON error depending on the route type.
- **Done when:** Browser navigation to an unknown instance is handled intentionally and test coverage exists.
- **Verification:**
  ```bash
  pytest -q
  ```
- **Risk / notes:** Keep route-specific behavior consistent: HTML for page routes, JSON for API routes.

### INST-012. Document new instance workflow and environment assumptions

- [x] **Status:** Completed
- **Priority:** Medium
- **Depends on:** INST-006, INST-008
- **Files to touch:** `README.md`, `.env.example`
- **Problem:** The current README describes a single shared map workflow and does not explain instance creation, instance URLs, or configuration expectations.
- **Expected outcome:** Documentation covers the new landing flow, per-instance URLs, JSON expectations, and any limits of configurable logic.
- **Done when:** A developer can run the app locally and understand the multi-instance flow from the repository docs alone.
- **Verification:**
  ```bash
  pytest -q
  ```
- **Risk / notes:** Update examples to reflect instance-scoped usage without overpromising future auth or sandboxed logic.

---

## Suggested loop order

1. `INST-001`
2. `INST-002`
3. `INST-003`
4. `INST-004`
5. `INST-005`
6. `INST-006`
7. `INST-007`
8. `INST-008`
9. `INST-009`
10. `INST-010`
11. `INST-011`
12. `INST-012`

---

## Completion rule

A task can be changed from `- [ ]` to `- [x]` only when:

- The implementation is complete.
- The listed verification command has been run.
- Any failure is documented with a follow-up task.
- The change is committed if it modifies repository files.
