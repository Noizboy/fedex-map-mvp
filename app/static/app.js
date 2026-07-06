let map;
let markers = [];
let infoWindow;
let googleMapsLoader;
let userLocationDot;
let userAccuracyCircle;
let userWatchId;
let preserveGpsViewport = false;
let selectedStop = null;
let selectedMarker = null;
let allStops = [];
let currentStops = [];
let hiddenStopIds = new Set();
let stopDisplayNumbers = new Map();
let showCompletedStops = false;
let activeTab = 'home';
let listSearchQuery = '';
let listStatusFilter = 'all';

const COMING_SOON_CONTENT = {
  performance: {
    title: 'Performance Coming Soon',
    description: 'A dedicated performance workspace is being prepared so you can review route metrics, trends, and delivery progress in one place.',
    feature: 'Route insights and productivity tracking',
    detail: 'This area will surface the most useful indicators for daily execution and follow-up.',
  },
  options: {
    title: 'Options Coming Soon',
    description: 'A settings area is on the way to centralize app preferences, map behavior, and workflow controls.',
    feature: 'Configuration tools and app preferences',
    detail: 'This section will make it easier to tailor the experience without leaving the main app.',
  },
};

const EMPTY_IMPORT_JSON = JSON.stringify({ records: [] }, null, 2);
const IMPORT_JSON_STORAGE_KEY = 'fedex-map-import-json';
const HIDDEN_STOPS_STORAGE_KEY = 'fedex-map-hidden-stop-ids';
const SHOW_COMPLETED_STOPS_STORAGE_KEY = 'fedex-map-show-completed-stops';

async function readJsonResponse(response) {
  const body = await response.text();
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Server returned an invalid response');
  }
}

function apiKey() {
  return window.APP_CONFIG?.googleMapsApiKey || '';
}

function pageType() {
  return window.APP_CONFIG?.pageType || 'instance';
}

function instanceSlug() {
  return window.APP_CONFIG?.instanceSlug || '';
}

function scopedStorageKey(key) {
  const slug = instanceSlug();
  return slug ? `${key}:${slug}` : key;
}

function instanceApiUrl(path = '') {
  const slug = instanceSlug();
  if (!slug) {
    throw new Error('Missing instance context');
  }

  return `/api/instances/${encodeURIComponent(slug)}${path}`;
}

function setStatus(message, isError = false) {
  const el = document.getElementById('status');
  if (!el) {
    return;
  }
  el.textContent = message;
  el.style.color = isError ? '#b42318' : '#6b7280';
}

function importTextarea() {
  return document.getElementById('json-input');
}

function readFileAsText(file) {
  if (typeof file?.text === 'function') {
    return file.text();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected JSON file'));
    reader.readAsText(file);
  });
}

function loadSavedImportJson() {
  try {
    const saved = window.localStorage.getItem(scopedStorageKey(IMPORT_JSON_STORAGE_KEY));
    return saved || EMPTY_IMPORT_JSON;
  } catch {
    return EMPTY_IMPORT_JSON;
  }
}

function saveImportJson(value) {
  try {
    window.localStorage.setItem(scopedStorageKey(IMPORT_JSON_STORAGE_KEY), value);
  } catch {
    // Ignore storage failures so import still works in restricted browsers.
  }
}

function loadHiddenStopIds() {
  try {
    const saved = window.localStorage.getItem(scopedStorageKey(HIDDEN_STOPS_STORAGE_KEY));
    if (!saved) {
      return new Set();
    }

    const stopIds = JSON.parse(saved);
    if (!Array.isArray(stopIds)) {
      return new Set();
    }

    return new Set(stopIds.map((stopId) => String(stopId)));
  } catch {
    return new Set();
  }
}

function saveHiddenStopIds() {
  try {
    window.localStorage.setItem(scopedStorageKey(HIDDEN_STOPS_STORAGE_KEY), JSON.stringify([...hiddenStopIds]));
  } catch {
    // Ignore storage failures so hiding stops still works for the current session.
  }
}

function resetHiddenStopIds() {
  hiddenStopIds = new Set();
  saveHiddenStopIds();
}

function loadShowCompletedStops() {
  try {
    return window.localStorage.getItem(scopedStorageKey(SHOW_COMPLETED_STOPS_STORAGE_KEY)) === 'true';
  } catch {
    return false;
  }
}

function saveShowCompletedStops() {
  try {
    window.localStorage.setItem(scopedStorageKey(SHOW_COMPLETED_STOPS_STORAGE_KEY), showCompletedStops ? 'true' : 'false');
  } catch {
    // Ignore storage failures so the toggle still works for the current session.
  }
}

function resetImportJson() {
  const textarea = importTextarea();
  if (textarea) {
    textarea.value = EMPTY_IMPORT_JSON;
  }
  saveImportJson(EMPTY_IMPORT_JSON);
}

function selectAllImportJson() {
  const textarea = importTextarea();
  if (!textarea) {
    return;
  }
  textarea.focus();
  textarea.select();
}

function showImportPanel(visible) {
  const panel = document.getElementById('import-panel');
  if (!panel) {
    return;
  }
  panel.classList.toggle('hidden', !visible);
  panel.setAttribute('aria-hidden', visible ? 'false' : 'true');

  if (visible) {
    window.setTimeout(selectAllImportJson, 0);
  }
}

function setInstanceMenuOpen(isOpen) {
  const trigger = document.getElementById('instance-menu-trigger');
  const dropdown = document.getElementById('instance-menu-dropdown');
  if (!trigger || !dropdown) {
    return;
  }

  trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  dropdown.classList.toggle('hidden', !isOpen);
}

function toggleInstanceMenu() {
  const trigger = document.getElementById('instance-menu-trigger');
  if (!trigger) {
    return;
  }

  setInstanceMenuOpen(trigger.getAttribute('aria-expanded') !== 'true');
}

function clearMarkers() {
  markers.forEach((marker) => marker.setMap(null));
  markers = [];
}

function buildGoogleMapsUrl(stop) {
  const query = `${stop.lat},${stop.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function sameStopId(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }

  return String(left) === String(right);
}

function isHiddenStop(stop) {
  return hiddenStopIds.has(String(stop?.id));
}

function getStopDisplayNumber(stop) {
  const stopId = String(stop?.id);
  return stop.stop_number ?? stopDisplayNumbers.get(stopId);
}

function getSortedStops() {
  return [...allStops].sort((left, right) => getStopDisplayNumber(left) - getStopDisplayNumber(right));
}

function isCompletedStop(stop) {
  return isHiddenStop(stop);
}

function stopStatusLabel(stop) {
  return isCompletedStop(stop) ? 'Completed' : 'Not completed';
}

function stopMatchesListFilters(stop) {
  const normalizedQuery = listSearchQuery.trim().toLowerCase();
  const address = popupAddress(stop).toLowerCase();
  const completed = isCompletedStop(stop);

  if (normalizedQuery && !address.includes(normalizedQuery)) {
    return false;
  }

  if (listStatusFilter === 'completed' && !completed) {
    return false;
  }

  if (listStatusFilter === 'pending' && completed) {
    return false;
  }

  return true;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStopsList() {
  const listEl = document.getElementById('stops-list');
  if (!listEl) {
    return;
  }

  const stops = getSortedStops().filter(stopMatchesListFilters);
  if (!stops.length) {
    listEl.innerHTML = allStops.length
      ? '<div class="empty-panel-state">No stops match the current search or filter.</div>'
      : '<div class="empty-panel-state">No stops loaded yet.</div>';
    return;
  }

  listEl.innerHTML = stops.map((stop) => {
    const completed = isCompletedStop(stop);
    const statusClass = completed ? 'completed' : 'pending';
    const statusLabel = stopStatusLabel(stop);
    const stopNumber = getStopDisplayNumber(stop);
    const address = popupAddress(stop);

    return `
      <article class="stop-list-item" data-stop-id="${escapeHtml(stop.id)}" role="button" tabindex="0" aria-label="Open stop ${escapeHtml(stopNumber)} on map">
        <div class="stop-list-number">#${escapeHtml(stopNumber)}</div>
        <div class="stop-list-address">
          <strong>${escapeHtml(address)}</strong>
          <span>Stop ${escapeHtml(stopNumber)}</span>
        </div>
        <div class="stop-list-status ${statusClass}">${escapeHtml(statusLabel)}</div>
      </article>
    `;
  }).join('');
}

function updateComingSoonPanel(tab) {
  const content = COMING_SOON_CONTENT[tab];
  if (!content) {
    return;
  }

  const title = document.getElementById('coming-soon-title');
  const description = document.getElementById('coming-soon-description');
  const feature = document.getElementById('coming-soon-feature');
  const detail = document.getElementById('coming-soon-detail');

  if (title) {
    title.textContent = content.title;
  }

  if (description) {
    description.textContent = content.description;
  }

  if (feature) {
    feature.textContent = content.feature;
  }

  if (detail) {
    detail.textContent = content.detail;
  }
}

function shouldUseMobileComingSoonPanel() {
  return window.matchMedia('(max-width: 640px)').matches;
}

function openStopInfo(marker, stop) {
  setSelectedStop(stop);
  infoWindow.setContent(`
    <div class="fedex-popup">
      <div class="popup-address">${escapeHtml(popupAddress(stop))}</div>
      <div class="popup-address-sub">Stop ${escapeHtml(getStopDisplayNumber(stop))}</div>
    </div>
  `);
  infoWindow.open({ anchor: marker, map });
}

async function focusStopOnMap(stopId) {
  const stop = allStops.find((item) => sameStopId(item.id, stopId));
  if (!stop) {
    return;
  }

  if (isCompletedStop(stop) && !showCompletedStops) {
    showCompletedStops = true;
    saveShowCompletedStops();
    updateCompletedStopsToggle();
  }

  setActiveTab('home');
  await renderCurrentStops();

  const marker = markers.find((item) => sameStopId(item.__stopId, stop.id));
  if (!marker) {
    return;
  }

  map.panTo(marker.getPosition());
  map.setZoom(Math.max(map.getZoom() || 15, 16));
  openStopInfo(marker, stop);
}

function setActiveTab(tab) {
  activeTab = tab;
  const isHome = tab === 'home';
  const mapStage = document.querySelector('.map-stage');
  const mapToolbar = document.querySelector('.map-toolbar');
  const listPanel = document.getElementById('list-panel');
  const comingSoonPanel = document.getElementById('coming-soon-panel');
  const selectedStopActions = document.getElementById('selected-stop-actions');
  const gpsButton = document.getElementById('gps-center');
  const completedStopsToggle = document.getElementById('toggle-completed-stops');

  document.querySelectorAll('.phone-nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.tab === tab);
  });

  if (mapStage) {
    mapStage.classList.toggle('hidden', !isHome);
  }

  if (mapToolbar) {
    mapToolbar.classList.toggle('hidden', !isHome);
  }

  if (listPanel) {
    const visible = tab === 'list';
    listPanel.classList.toggle('hidden', !visible);
    listPanel.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  if (comingSoonPanel) {
    const visible = shouldUseMobileComingSoonPanel() && (tab === 'performance' || tab === 'options');
    comingSoonPanel.classList.toggle('hidden', !visible);
    comingSoonPanel.setAttribute('aria-hidden', visible ? 'false' : 'true');

    if (visible) {
      updateComingSoonPanel(tab);
    }
  }

  if (gpsButton) {
    gpsButton.classList.toggle('hidden', !isHome);
  }

  if (completedStopsToggle) {
    completedStopsToggle.classList.toggle('hidden', !isHome);
  }

  if (selectedStopActions && !isHome) {
    setSelectedStop(null);
  }

  if (tab === 'list') {
    renderStopsList();
    setStatus('');
    return;
  }

  if (!shouldUseMobileComingSoonPanel() && tab === 'performance') {
    setStatus('Performance: will be added in the next phase.');
    return;
  }

  if (!shouldUseMobileComingSoonPanel() && tab === 'options') {
    setStatus('Options: will be added in the next phase.');
    return;
  }

  setStatus('');
}

function getRenderableStops() {
  if (showCompletedStops) {
    return allStops;
  }

  return allStops.filter((stop) => !isHiddenStop(stop));
}

function updateCompletedStopsToggle() {
  const button = document.getElementById('toggle-completed-stops');
  if (!button) {
    return;
  }

  const label = showCompletedStops ? 'Hide completed stops' : 'Show completed stops';
  button.classList.toggle('is-active', showCompletedStops);
  button.setAttribute('aria-pressed', showCompletedStops ? 'true' : 'false');
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);

  const icon = button.querySelector('i');
  if (icon) {
    icon.setAttribute('data-lucide', showCompletedStops ? 'eye-off' : 'eye');
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function setSelectedStop(stop) {
  selectedStop = stop;
  selectedMarker = markers.find((marker) => sameStopId(marker.__stopId, stop?.id)) || null;
  const panel = document.getElementById('selected-stop-actions');
  const googleMapsLink = document.getElementById('open-google-maps');
  const completeStopButton = document.getElementById('complete-stop');
  if (!panel || !googleMapsLink || !completeStopButton) {
    return;
  }

  const visible = Boolean(stop);
  panel.classList.toggle('hidden', !visible);
  panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
  googleMapsLink.href = visible ? buildGoogleMapsUrl(stop) : '#';
  completeStopButton.disabled = visible ? isCompletedStop(stop) : false;
  completeStopButton.title = visible && isCompletedStop(stop) ? 'Stop already completed' : 'Mark as completed';
  completeStopButton.setAttribute('aria-label', completeStopButton.title);
}

function createPinIcon(maps, isCompleted = false) {
  // The pin art keeps a wider white cap so Google Maps labels still fit 1-3 digits.
  const width = 56;
  const height = 68;
  const topColor = isCompleted ? '#9ca3af' : '#ff4d4f';
  const bottomColor = isCompleted ? '#6b7280' : '#d9363e';
  const strokeColor = isCompleted ? '#4b5563' : '#a61d24';
  const svg = `
    <svg width="56" height="68" viewBox="0 0 56 68" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="4" y="6" width="48" height="58" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix"/>
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
          <feOffset dy="2"/>
          <feGaussianBlur stdDeviation="2"/>
          <feComposite in2="hardAlpha" operator="out"/>
          <feColorMatrix type="matrix" values="0 0 0 0 0.0588235 0 0 0 0 0.0941176 0 0 0 0 0.160784 0 0 0 0.2 0"/>
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_1_1"/>
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_1_1" result="shape"/>
        </filter>
        <linearGradient id="pinFill" x1="28" y1="10" x2="28" y2="58" gradientUnits="userSpaceOnUse">
          <stop stop-color="${topColor}"/>
          <stop offset="1" stop-color="${bottomColor}"/>
        </linearGradient>
      </defs>
      <g filter="url(#shadow)">
        <path d="M28 10C17.5066 10 9 18.5066 9 29C9 42.1345 24.9429 55.9557 27.2795 57.9088C27.6999 58.2602 28.3001 58.2602 28.7205 57.9088C31.0571 55.9557 47 42.1345 47 29C47 18.5066 38.4934 10 28 10Z" fill="url(#pinFill)"/>
        <path d="M28 10.75C17.9208 10.75 9.75 18.9208 9.75 29C9.75 35.2987 13.5917 41.7872 18.4064 47.3709C22.2856 51.8696 26.2913 55.1433 28 56.5424C29.7087 55.1433 33.7144 51.8696 37.5936 47.3709C42.4083 41.7872 46.25 35.2987 46.25 29C46.25 18.9208 38.0792 10.75 28 10.75Z" stroke="${strokeColor}" stroke-opacity="0.32" stroke-width="1.5"/>
      </g>
    </svg>`;

  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new maps.Size(width, height),
    origin: new maps.Point(0, 0),
    anchor: new maps.Point(width / 2, height - 9),
    labelOrigin: new maps.Point(width / 2, 28),
  };
}

function createPinLabel(number, isCompleted = false) {
  const text = String(number);
  return {
    text,
    color: isCompleted ? '#f3f4f6' : '#ffffff',
    fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif',
    fontSize: '15px',
    fontWeight: '700',
  };
}

async function renderCurrentStops() {
  await renderMap(getRenderableStops());
  renderStopsList();
}

async function toggleCompletedStops() {
  showCompletedStops = !showCompletedStops;
  saveShowCompletedStops();
  updateCompletedStopsToggle();
  await renderCurrentStops();
}

function ensureMapContainerMessage(message) {
  const mapEl = document.getElementById('map');
  if (!mapEl) {
    return;
  }
  mapEl.innerHTML = `<div class="map-message">${message}</div>`;
}

function loadGoogleMaps() {
  if (window.google?.maps) {
    return Promise.resolve(window.google.maps);
  }

  const key = apiKey();
  if (!key) {
    return Promise.reject(new Error('GOOGLE_MAPS_API_KEY is not configured for loading Google Maps.'));
  }

  if (googleMapsLoader) {
    return googleMapsLoader;
  }

  googleMapsLoader = new Promise((resolve, reject) => {
    window.__initFedExGoogleMap = () => resolve(window.google.maps);

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__initFedExGoogleMap&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error('Could not load Google Maps.'));
    document.head.appendChild(script);
  });

  return googleMapsLoader;
}

function zoomMapBy(delta) {
  if (!map) {
    return;
  }
  const currentZoom = map.getZoom() ?? 11;
  map.setZoom(Math.max(1, Math.min(21, currentZoom + delta)));
}

function installMapZoomGestures(mapEl) {
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let lastTwoFingerTapAt = 0;

  map.addListener('dblclick', () => {
    const beforeZoom = map.getZoom();
    window.setTimeout(() => {
      if (map.getZoom() === beforeZoom) {
        zoomMapBy(1);
      }
    }, 80);
  });

  mapEl.addEventListener('touchend', (event) => {
    const now = Date.now();
    const touch = event.changedTouches?.[0];
    if (!touch) {
      return;
    }

    // Two fingers: fast zoom out. One finger: double tap to zoom in.
    if (event.changedTouches.length >= 2 || event.touches.length >= 2) {
      if (now - lastTwoFingerTapAt < 330) {
        event.preventDefault();
        zoomMapBy(-1);
        lastTwoFingerTapAt = 0;
      } else {
        lastTwoFingerTapAt = now;
      }
      return;
    }

    const dx = Math.abs(touch.clientX - lastTapX);
    const dy = Math.abs(touch.clientY - lastTapY);
    const isDoubleTap = now - lastTapAt < 300 && dx < 36 && dy < 36;
    if (isDoubleTap) {
      event.preventDefault();
      zoomMapBy(1);
      lastTapAt = 0;
      return;
    }

    lastTapAt = now;
    lastTapX = touch.clientX;
    lastTapY = touch.clientY;
  }, { passive: false });
}

function setGpsButtonState(isLocating, isLocated = false) {
  const button = document.getElementById('gps-center');
  if (!button) {
    return;
  }
  button.classList.toggle('locating', isLocating);
  button.classList.toggle('located', !isLocating && isLocated);
  button.disabled = isLocating;
  button.setAttribute(
    'aria-label',
    isLocating
      ? 'Locating you...'
      : isLocated
        ? 'Center on my current location (known location)'
        : 'Center on my location'
  );
}

function isUserLocated() {
  return Boolean(userLocationDot && userLocationDot.getCenter());
}

function drawUserLocation(position, shouldCenter = true) {
  if (!map || !window.google?.maps) {
    return;
  }
  const maps = window.google.maps;
  const coords = position.coords;
  const current = { lat: coords.latitude, lng: coords.longitude };

  if (!userLocationDot) {
    userLocationDot = new maps.Circle({
      map,
      center: current,
      radius: 7,
      strokeColor: '#ffffff',
      strokeOpacity: 1,
      strokeWeight: 3,
      fillColor: '#1a73e8',
      fillOpacity: 1,
      clickable: false,
      zIndex: 9999,
    });
  } else {
    userLocationDot.setCenter(current);
  }

  if (!userAccuracyCircle) {
    userAccuracyCircle = new maps.Circle({
      map,
      center: current,
      radius: coords.accuracy || 25,
      strokeColor: '#0f62fe',
      strokeOpacity: 0.35,
      strokeWeight: 1,
      fillColor: '#0f62fe',
      fillOpacity: 0.14,
      clickable: false,
    });
  } else {
    userAccuracyCircle.setCenter(current);
    userAccuracyCircle.setRadius(coords.accuracy || 25);
  }

  if (shouldCenter) {
    preserveGpsViewport = true;
    map.panTo(current);
    map.setZoom(Math.max(map.getZoom() || 16, 17));
  }
}

async function centerOnGps(options = {}) {
  const { silent = false } = options;
  await ensureMap();
  if (!navigator.geolocation) {
    if (!silent) {
      setStatus('GPS not available on this device.', true);
    }
    return;
  }

  setGpsButtonState(true, isUserLocated());
  navigator.geolocation.getCurrentPosition(
    (position) => {
      drawUserLocation(position, true);
      if (!silent) {
        setStatus('GPS centered on your current location.');
      }
      setGpsButtonState(false, true);
    },
    (error) => {
      if (!silent) {
        setStatus(`Could not access GPS: ${error.message}`, true);
      }
      setGpsButtonState(false, false);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
  );

  if (userWatchId === undefined) {
    userWatchId = navigator.geolocation.watchPosition(
      (position) => {
        drawUserLocation(position, false);
        setGpsButtonState(false, true);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  }
}

async function ensureMap() {
  try {
    const maps = await loadGoogleMaps();
    if (map) {
      return maps;
    }

    const mapEl = document.getElementById('map');
    map = new maps.Map(mapEl, {
      center: { lat: 28.2919, lng: -81.4079 },
      zoom: 11,
      mapTypeControl: false,
      fullscreenControl: false,
      zoomControl: false,
      disableDoubleClickZoom: false,
      streetViewControl: false,
      clickableIcons: false,
      gestureHandling: 'greedy',
    });
    window.__fedexMap = map;
    window.__fedexZoomMapBy = zoomMapBy;
    window.__fedexDrawUserLocation = drawUserLocation;
    installMapZoomGestures(mapEl);
    infoWindow = new maps.InfoWindow();
    return maps;
  } catch (error) {
    ensureMapContainerMessage(error.message);
    throw error;
  }
}

function popupAddress(stop) {
  return `${stop.house_number} ${stop.street_name}`.trim();
}

async function completeSelectedStop(event) {
  event?.preventDefault();
  event?.stopPropagation();

  if (!selectedStop) {
    return;
  }

  const completedStop = selectedStop;
  const completedAddress = popupAddress(completedStop);
  hiddenStopIds.add(String(completedStop.id));
  saveHiddenStopIds();

  try {
    infoWindow.close();
    setSelectedStop(null);
    await renderCurrentStops();

    setStatus(`Completed stop: ${completedAddress}`);
  } catch (error) {
    hiddenStopIds.delete(String(completedStop.id));
    saveHiddenStopIds();
    await fetchStops();
    setStatus(error.message, true);
  }
}

async function renderMap(stops) {
  const maps = await ensureMap();
  currentStops = stops;
  clearMarkers();
  setSelectedStop(null);
  infoWindow.close();

  const bounds = new maps.LatLngBounds();

  stops.forEach((stop) => {
    const stopNumber = getStopDisplayNumber(stop);
    const completed = isCompletedStop(stop);
    const position = { lat: stop.lat, lng: stop.lng };

    const marker = new maps.Marker({
      position,
      map,
      icon: createPinIcon(maps, completed),
      label: createPinLabel(stopNumber, completed),
      title: popupAddress(stop),
    });
    marker.__stopId = stop.id;

    marker.addListener('click', () => {
      openStopInfo(marker, stop);
    });

    markers.push(marker);
    bounds.extend(position);
  });

  maps.event.clearListeners(map, 'click');
  map.addListener('click', () => {
    infoWindow.close();
    setSelectedStop(null);
  });

  if (preserveGpsViewport && isUserLocated()) {
    return;
  }

  if (stops.length === 1) {
    map.setCenter({ lat: stops[0].lat, lng: stops[0].lng });
    map.setZoom(15);
  } else if (stops.length > 1) {
    map.fitBounds(bounds, 40);
  }
}

async function fetchStops() {
  const response = await fetch(instanceApiUrl('/stops'), {
    cache: 'no-store',
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not load the stops');
  }
  allStops = data.stops || [];
  stopDisplayNumbers = new Map(
    allStops.map((stop, idx) => [String(stop.id), stop.stop_number ?? (idx + 1)])
  );
  await renderCurrentStops();
}

async function sendJson() {
  const textarea = importTextarea();
  try {
    const payload = JSON.parse(textarea.value);
    const response = await fetch(instanceApiUrl('/ingest-json'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(data.detail || 'Could not save the JSON');
    }
    saveImportJson(textarea.value);
    setStatus(`Saved: ${data.created}, duplicates: ${data.duplicates}`);
    await fetchStops();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function requestStopClear() {
  const deleteResponse = await fetch(instanceApiUrl('/stops'), {
    method: 'DELETE',
    cache: 'no-store',
  });

  if (deleteResponse.ok) {
    return deleteResponse;
  }

  if (deleteResponse.status !== 404 && deleteResponse.status !== 405) {
    return deleteResponse;
  }

  const clearRouteResponse = await fetch(instanceApiUrl('/stops/clear'), {
    method: 'POST',
    cache: 'no-store',
  });

  if (clearRouteResponse.ok) {
    return clearRouteResponse;
  }

  if (clearRouteResponse.status !== 404 && clearRouteResponse.status !== 405) {
    return clearRouteResponse;
  }

  return fetch(instanceApiUrl('/stops'), {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'clear' }),
  });
}

async function clearImportedStops() {
  try {
    const response = await requestStopClear();
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(data.detail || 'Could not clear the stops');
    }

    resetHiddenStopIds();
    stopDisplayNumbers = new Map();
    resetImportJson();
    setStatus(`Cleared ${data.deleted} stops`);
    await fetchStops();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function initLandingPage() {
  const form = document.getElementById('create-instance-form');
  const statusEl = document.getElementById('landing-status');
  const fileInput = document.getElementById('instance-json-file');
  const jsonTextarea = document.getElementById('instance-json');
  const submitButton = document.getElementById('create-instance-button');
  if (!form || !statusEl) {
    return;
  }

  function validateLandingJson() {
    const rawValue = jsonTextarea?.value.trim() || '';
    if (!rawValue) {
      if (submitButton) {
        submitButton.disabled = false;
      }
      statusEl.textContent = '';
      return true;
    }

    try {
      JSON.parse(rawValue);
      if (submitButton) {
        submitButton.disabled = false;
      }
      statusEl.textContent = 'JSON ready for instance creation.';
      return true;
    } catch {
      if (submitButton) {
        submitButton.disabled = true;
      }
      statusEl.textContent = 'JSON text is invalid. Fix it before creating the instance.';
      return false;
    }
  }

  jsonTextarea?.addEventListener('input', validateLandingJson);

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file || !jsonTextarea) {
      return;
    }

    try {
      jsonTextarea.value = await readFileAsText(file);
      validateLandingJson();
      if (!submitButton?.disabled) {
        statusEl.textContent = 'JSON loaded into JSON text.';
      }
    } catch (error) {
      if (submitButton) {
        submitButton.disabled = true;
      }
      statusEl.textContent = error.message || 'Could not read the selected JSON file';
    }
  });

  validateLandingJson();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!validateLandingJson()) {
      return;
    }

    const name = document.getElementById('instance-name')?.value.trim() || '';
    const initialDataRaw = document.getElementById('instance-json')?.value.trim() || '';

    try {
      const payload = { name };
      if (initialDataRaw) {
        payload.initial_data = JSON.parse(initialDataRaw);
      }

      const response = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(data.detail || 'Could not create the instance');
      }

      window.location.href = data.instance.url_path;
    } catch (error) {
      statusEl.textContent = error.message;
    }
  });
}

async function initInstancePage() {
  const textarea = importTextarea();
  const instanceMenu = document.querySelector('.instance-menu');
  const instanceMenuTrigger = document.getElementById('instance-menu-trigger');
  const openImportButton = document.getElementById('open-import');
  const reloadMapButton = document.getElementById('reload-map');
  const toggleCompletedStopsButton = document.getElementById('toggle-completed-stops');
  const closeImportButton = document.getElementById('close-import');
  const gpsCenterButton = document.getElementById('gps-center');
  const sendJsonButton = document.getElementById('send-json');
  const clearJsonButton = document.getElementById('clear-json');
  hiddenStopIds = loadHiddenStopIds();
  showCompletedStops = loadShowCompletedStops();
  if (textarea) {
    textarea.value = loadSavedImportJson();
    textarea.addEventListener('input', () => saveImportJson(textarea.value));
    textarea.addEventListener('focus', selectAllImportJson);
    textarea.addEventListener('click', selectAllImportJson);
  }

  instanceMenuTrigger.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleInstanceMenu();
  });
  instanceMenu?.addEventListener('click', (event) => event.stopPropagation());
  openImportButton.addEventListener('click', () => {
    setInstanceMenuOpen(false);
    showImportPanel(true);
  });
  closeImportButton.addEventListener('click', () => showImportPanel(false));
  reloadMapButton.addEventListener('click', async () => {
    setInstanceMenuOpen(false);
    await fetchStops();
  });
  toggleCompletedStopsButton.addEventListener('click', async () => {
    setInstanceMenuOpen(false);
    await toggleCompletedStops();
  });
  gpsCenterButton.addEventListener('click', centerOnGps);
  sendJsonButton.addEventListener('click', sendJson);
  clearJsonButton.addEventListener('click', clearImportedStops);
  const selectedStopActions = document.getElementById('selected-stop-actions');
  const completeStopButton = document.getElementById('complete-stop');
  const listSearchInput = document.getElementById('list-search');
  const listStatusFilterSelect = document.getElementById('list-status-filter');
  const stopsList = document.getElementById('stops-list');

  document.addEventListener('click', () => setInstanceMenuOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setInstanceMenuOpen(false);
      showImportPanel(false);
    }
  });

  updateCompletedStopsToggle();
  completeStopButton.addEventListener('click', completeSelectedStop);
  selectedStopActions.addEventListener('click', (event) => event.stopPropagation());
  selectedStopActions.addEventListener('pointerdown', (event) => event.stopPropagation());
  selectedStopActions.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });

  listSearchInput.addEventListener('input', (event) => {
    listSearchQuery = event.target.value;
    renderStopsList();
  });

  listStatusFilterSelect.addEventListener('change', (event) => {
    listStatusFilter = event.target.value;
    renderStopsList();
  });

  stopsList.addEventListener('click', async (event) => {
    const item = event.target.closest('[data-stop-id]');
    if (!item) {
      return;
    }

    await focusStopOnMap(item.dataset.stopId);
  });

  stopsList.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    const item = event.target.closest('[data-stop-id]');
    if (!item) {
      return;
    }

    event.preventDefault();
    await focusStopOnMap(item.dataset.stopId);
  });

  document.querySelectorAll('.phone-nav-item').forEach((item) => {
    item.addEventListener('click', () => setActiveTab(item.dataset.tab || 'home'));
  });

  setActiveTab(activeTab);

  try {
    await fetchStops();
    void centerOnGps({ silent: true });
  } catch (error) {
    setStatus(error.message, true);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  if (pageType() === 'landing') {
    await initLandingPage();
    return;
  }

  await initInstancePage();
});
