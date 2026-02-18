"use strict";

// ============================================
// ElectroChile - EV Charging Station Finder
// Powered by EcoCarga (Ministerio de Energia)
// ============================================

var ECOCARGA_API = "https://backend.electromovilidadenlinea.cl/locations";
var NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
var OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
var CHILE_CENTER = [-33.45, -70.65];
var PAGE_SIZE = 500;
var CACHE_KEY = "electrochile_stations";
var CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Terrain consumption multipliers (kWh/100km base ~15)
var TERRAIN = {
    flat:     { factor: 1.0,  label: "Plano",   consumption: 15 },
    moderate: { factor: 1.15, label: "Colinas",  consumption: 17 },
    mountain: { factor: 1.4,  label: "Montaña",  consumption: 21 }
};

// How close to route a station must be (km)
var ROUTE_CORRIDOR_KM = 5;

// SVG icons for connector types
var CONNECTOR_ICONS = {
    "CCS 2": '<svg class="conn-svg" viewBox="0 0 24 24"><circle cx="8" cy="7" r="2.5"/><circle cx="16" cy="7" r="2.5"/><rect x="6" y="13" width="12" height="5" rx="2"/><rect x="4" y="2" width="16" height="18" rx="3" fill="none" stroke-width="1.5"/></svg>',
    "Tipo 2": '<svg class="conn-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke-width="1.5"/><circle cx="12" cy="7" r="1.8"/><circle cx="7.5" cy="10.5" r="1.8"/><circle cx="16.5" cy="10.5" r="1.8"/><circle cx="9" cy="15.5" r="1.8"/><circle cx="15" cy="15.5" r="1.8"/></svg>',
    "CHAdeMO": '<svg class="conn-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke-width="1.5"/><circle cx="8" cy="9" r="2"/><circle cx="16" cy="9" r="2"/><circle cx="8" cy="15" r="2"/><circle cx="16" cy="15" r="2"/></svg>',
    "Tipo 1": '<svg class="conn-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke-width="1.5"/><circle cx="9" cy="9" r="1.8"/><circle cx="15" cy="9" r="1.8"/><circle cx="12" cy="15" r="1.8"/></svg>'
};

var CONN_ICON_DEFAULT = '<svg class="conn-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke-width="1.5"/><path d="M12 7v10M7 12h10" stroke-width="1.5"/></svg>';

// ---- App State ----
var state = {
    map: null,
    markerCluster: null,
    userMarker: null,
    allStations: [],
    stations: [],
    userLocation: null,
    communes: [],
    // Route planner
    routeLayer: null,
    routeStopMarkers: [],
    originMarker: null,
    destMarker: null,
    plannerOrigin: null, // { lat, lng, name }
    plannerDest: null
};

// ---- DOM ----
var dom = {};

function cacheDom() {
    dom.searchInput = document.getElementById("search-input");
    dom.searchBtn = document.getElementById("search-btn");
    dom.locateBtn = document.getElementById("locate-btn");
    dom.acList = document.getElementById("autocomplete-list");
    dom.radiusRange = document.getElementById("radius-range");
    dom.radiusValue = document.getElementById("radius-value");
    dom.connectorFilters = document.getElementById("connector-filters");
    dom.powerTypeFilters = document.getElementById("power-type-filters");
    dom.statusFilter = document.getElementById("status-filter");
    dom.resultsList = document.getElementById("results-list");
    dom.resultsCount = document.getElementById("results-count");
    dom.loading = document.getElementById("loading");
    dom.loadingText = document.getElementById("loading-text");
    dom.sidebar = document.getElementById("sidebar");
    dom.sidebarToggle = document.getElementById("sidebar-toggle");
    dom.sidebarClose = document.getElementById("sidebar-close");
    dom.dataInfo = document.getElementById("data-info");
    // Tabs
    dom.tabBtns = document.querySelectorAll(".tab-btn");
    dom.tabFinder = document.getElementById("tab-finder");
    dom.tabPlanner = document.getElementById("tab-planner");
    // Planner
    dom.plannerOrigin = document.getElementById("planner-origin");
    dom.plannerDest = document.getElementById("planner-dest");
    dom.plannerOriginAC = document.getElementById("planner-origin-ac");
    dom.plannerDestAC = document.getElementById("planner-dest-ac");
    dom.plannerBattery = document.getElementById("planner-battery");
    dom.plannerTerrain = document.getElementById("planner-terrain");
    dom.plannerRangeKm = document.getElementById("planner-range-km");
    dom.plannerRangeDetail = document.getElementById("planner-range-detail");
    dom.plannerGo = document.getElementById("planner-go");
    dom.plannerResults = document.getElementById("planner-results");
    dom.plannerSummary = document.getElementById("planner-summary");
    dom.plannerStopsCount = document.getElementById("planner-stops-count");
    dom.plannerStopsList = document.getElementById("planner-stops-list");
    dom.plannerUseLocation = document.getElementById("planner-use-location");
}

// ============================================
// Init
// ============================================

function init() {
    cacheDom();
    initMap();
    initEvents();
    initPlannerEvents();
    loadAllStations();
    updateRangeEstimate();
}

function initMap() {
    state.map = L.map("map", {
        center: CHILE_CENTER,
        zoom: 6,
        maxBounds: [[-60, -80], [-15, -60]],
        minZoom: 4
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | <a href="https://energia.gob.cl/electromovilidad/ecocarga" target="_blank">EcoCarga</a>',
        maxZoom: 19
    }).addTo(state.map);

    state.markerCluster = L.markerClusterGroup({
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false
    });
    state.map.addLayer(state.markerCluster);
}

function initEvents() {
    dom.searchBtn.addEventListener("click", handleSearch);
    dom.searchInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { closeAC(); handleSearch(); }
        if (e.key === "Escape") closeAC();
        if (e.key === "ArrowDown") navAC(1);
        if (e.key === "ArrowUp") { e.preventDefault(); navAC(-1); }
    });
    dom.searchInput.addEventListener("input", onSearchInput);

    document.addEventListener("click", function (e) {
        if (!dom.searchInput.contains(e.target) && !dom.acList.contains(e.target)) closeAC();
    });

    dom.locateBtn.addEventListener("click", handleGeolocate);

    dom.radiusRange.addEventListener("input", function () {
        dom.radiusValue.textContent = this.value + " km";
    });
    dom.radiusRange.addEventListener("change", function () {
        if (state.userLocation) filterByLocation(state.userLocation.lat, state.userLocation.lng);
    });

    dom.connectorFilters.addEventListener("change", function (e) { handleFilterToggle(e, dom.connectorFilters); });
    dom.powerTypeFilters.addEventListener("change", function (e) { handleFilterToggle(e, dom.powerTypeFilters); });
    dom.statusFilter.addEventListener("change", applyFilters);

    dom.sidebarToggle.addEventListener("click", function () { dom.sidebar.classList.add("open"); });
    dom.sidebarClose.addEventListener("click", function () { dom.sidebar.classList.remove("open"); });

    // Tabs
    dom.tabBtns.forEach(function (btn) {
        btn.addEventListener("click", function () {
            dom.tabBtns.forEach(function (b) { b.classList.remove("active"); });
            btn.classList.add("active");
            var tab = btn.dataset.tab;
            dom.tabFinder.classList.toggle("active", tab === "finder");
            dom.tabPlanner.classList.toggle("active", tab === "planner");
        });
    });
}

function handleFilterToggle(e, container) {
    var target = e.target;
    if (target.type !== "checkbox") return;
    var allCb = container.querySelector('input[value="all"]');
    var others = container.querySelectorAll('input:not([value="all"])');
    if (target.value === "all") {
        others.forEach(function (cb) { cb.checked = false; });
        allCb.checked = true;
    } else {
        allCb.checked = false;
        if (!Array.from(others).some(function (cb) { return cb.checked; })) allCb.checked = true;
    }
    applyFilters();
}

// ============================================
// Autocomplete - Predictive commune search
// ============================================

function buildCommuneIndex() {
    var map = {};
    state.allStations.forEach(function (s) {
        if (!s.commune) return;
        var k = s.commune.toLowerCase();
        if (!map[k]) map[k] = { name: s.commune, region: s.region, count: 0 };
        map[k].count++;
    });
    state.communes = Object.keys(map).map(function (k) { return map[k]; })
        .sort(function (a, b) { return b.count - a.count; });
}

var _searchDebounce = null;

function onSearchInput() {
    var v = dom.searchInput.value.trim();
    if (v.length < 2) { closeAC(); return; }
    showAC(v);
    // Also fetch Nominatim suggestions with debounce
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(function () { fetchNominatimAC(v, dom.acList, null); }, 350);
}

function showAC(q) {
    var ql = q.toLowerCase();
    var matches = state.communes.filter(function (c) {
        return c.name.toLowerCase().indexOf(ql) !== -1 || c.region.toLowerCase().indexOf(ql) !== -1;
    }).slice(0, 4);

    var html = "";
    if (matches.length) {
        html += '<div class="ac-section">Comunas</div>';
        matches.forEach(function (m, i) {
            html += '<div class="ac-item" data-i="' + i + '" data-name="' + escapeAttr(m.name) + '">' +
                '<span class="ac-name">' + hlMatch(m.name, ql) + '</span>' +
                '<span class="ac-meta">' + escapeHtml(m.region) + ' &middot; ' + m.count + ' est.</span></div>';
        });
    }

    // Keep existing Nominatim results if any
    var existingNom = dom.acList.querySelector(".ac-section-nominatim");
    var nomHtml = existingNom ? existingNom.outerHTML + getNominatimItemsHtml(dom.acList) : "";

    dom.acList.innerHTML = html + nomHtml;
    if (html || nomHtml) dom.acList.classList.remove("hidden");
    else closeAC();

    bindACItems(dom.acList);
}

function getNominatimItemsHtml(list) {
    var items = list.querySelectorAll(".ac-item-nominatim");
    var h = "";
    items.forEach(function (it) { h += it.outerHTML; });
    return h;
}

function fetchNominatimAC(q, listEl, callback) {
    fetch(NOMINATIM_BASE + "?q=" + encodeURIComponent(q + ", Chile") + "&format=json&limit=4&countrycodes=cl&addressdetails=1",
        { headers: { "Accept-Language": "es" } })
        .then(function (r) { return r.json(); })
        .then(function (results) {
            if (!results.length) { if (callback) callback(); return; }

            // Remove old Nominatim results
            var oldSection = listEl.querySelector(".ac-section-nominatim");
            if (oldSection) oldSection.remove();
            listEl.querySelectorAll(".ac-item-nominatim").forEach(function (it) { it.remove(); });

            var nomHtml = '<div class="ac-section ac-section-nominatim">Direcciones</div>';
            results.forEach(function (r) {
                var name = r.display_name.split(",").slice(0, 2).join(",");
                nomHtml += '<div class="ac-item ac-item-nominatim" data-name="' + escapeAttr(name) + '" data-lat="' + r.lat + '" data-lng="' + r.lon + '">' +
                    '<span class="ac-name">' + escapeHtml(name) + '</span>' +
                    '<span class="ac-meta">' + escapeHtml(r.display_name.split(",").slice(2, 4).join(",").trim()) + '</span></div>';
            });
            listEl.insertAdjacentHTML("beforeend", nomHtml);
            listEl.classList.remove("hidden");
            bindACItems(listEl);
            if (callback) callback();
        })
        .catch(function () { if (callback) callback(); });
}

function bindACItems(listEl) {
    listEl.querySelectorAll(".ac-item").forEach(function (it) {
        // Remove old listeners by cloning
        var clone = it.cloneNode(true);
        it.parentNode.replaceChild(clone, it);
        clone.addEventListener("mousedown", function (e) {
            e.preventDefault();
            var name = this.dataset.name;
            var lat = this.dataset.lat;
            var lng = this.dataset.lng;
            dom.searchInput.value = name;
            closeAC();
            if (lat && lng) {
                // Direct coordinates from Nominatim
                var la = parseFloat(lat), ln = parseFloat(lng);
                state.userLocation = { lat: la, lng: ln };
                state.map.setView([la, ln], 14);
                addUserMarker(la, ln);
                filterByLocation(la, ln);
            } else {
                geocodeSearch(name);
            }
        });
    });
}

function hlMatch(text, q) {
    var i = text.toLowerCase().indexOf(q);
    if (i === -1) return escapeHtml(text);
    return escapeHtml(text.substring(0, i)) + '<strong>' + escapeHtml(text.substring(i, i + q.length)) + '</strong>' + escapeHtml(text.substring(i + q.length));
}

function closeAC() {
    dom.acList.classList.add("hidden");
    dom.acList.innerHTML = "";
}

function navAC(dir) {
    var items = dom.acList.querySelectorAll(".ac-item");
    if (!items.length) return;
    var cur = dom.acList.querySelector(".ac-item.active");
    var idx = -1;
    if (cur) { idx = parseInt(cur.dataset.i, 10); cur.classList.remove("active"); }
    idx += dir;
    if (idx < 0) idx = items.length - 1;
    if (idx >= items.length) idx = 0;
    items[idx].classList.add("active");
    dom.searchInput.value = items[idx].dataset.name;
}

// ============================================
// Data Loading
// ============================================

function loadAllStations() {
    // Try cache first
    var cached = getCachedStations();
    if (cached) {
        showLoading(true, "Cargando desde cache...");
        state.allStations = cached.map(normalizeStation);
        state.stations = state.allStations.slice();
        buildCommuneIndex();
        dom.dataInfo.textContent = state.allStations.length + " estaciones | EcoCarga (cache)";
        tryGeolocation();
        // Refresh in background for next visit
        fetchAllFromAPI(true);
        return;
    }

    fetchAllFromAPI(false);
}

function fetchAllFromAPI(silent) {
    if (!silent) showLoading(true, "Conectando con EcoCarga...");

    fetchPage(1).then(function (first) {
        var allItems = first.items || [];
        if (!silent) showLoading(true, "Cargando " + first.total_items + " estaciones...");
        if (first.total_pages <= 1) return allItems;
        var p = [];
        for (var i = 2; i <= first.total_pages; i++) p.push(fetchPage(i));
        return Promise.all(p).then(function (pages) {
            pages.forEach(function (pg) { allItems = allItems.concat(pg.items || []); });
            return allItems;
        });
    }).then(function (items) {
        // Save to cache
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: items }));
        } catch (e) { /* quota exceeded, ignore */ }

        // Debug: log all unique raw EVSE statuses so we can see what the API returns
        var rawStatuses = {};
        items.forEach(function (item) {
            (item.evses || []).forEach(function (evse) {
                var s = evse.status || "(vacío)";
                rawStatuses[s] = (rawStatuses[s] || 0) + 1;
            });
        });
        console.log("[ElectroChile] EVSE statuses de la API:", rawStatuses);

        if (!silent) {
            state.allStations = items.map(normalizeStation);
            state.stations = state.allStations.slice();
            buildCommuneIndex();
            dom.dataInfo.textContent = state.allStations.length + " estaciones | EcoCarga";
            tryGeolocation();
        } else {
            state.allStations = items.map(normalizeStation);
            state.stations = state.allStations.slice();
            buildCommuneIndex();
            dom.dataInfo.textContent = state.allStations.length + " estaciones | EcoCarga";
        }
    }).catch(function (err) {
        console.error("Error:", err);
        if (!silent) {
            showLoading(false);
            dom.resultsList.innerHTML = '<div class="empty-state"><p>Error al conectar con EcoCarga.</p></div>';
        }
    });
}

function getCachedStations() {
    try {
        var raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        var obj = JSON.parse(raw);
        if (Date.now() - obj.ts > CACHE_TTL) return null;
        return obj.data;
    } catch (e) { return null; }
}

function fetchPage(page) {
    return fetch(ECOCARGA_API + "?page=" + page + "&items_per_page=" + PAGE_SIZE)
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
}

// Statuses that mean the charger is actively being used (OCPI whitelist)
// Only explicitly known "in use" statuses — everything else that's not AVAILABLE is treated as unavailable
var IN_USE_STATUSES = ["CHARGING", "FINISHING"];

function isEvseAvailable(status) {
    var s = (status || "").toUpperCase();
    return s === "AVAILABLE" || s === "DISPONIBLE";
}

function isEvseInUse(status) {
    var s = (status || "").toUpperCase();
    return IN_USE_STATUSES.indexOf(s) !== -1;
}

function normalizeStation(item) {
    var connectors = [];
    var maxPower = 0;
    var evseCount = 0;
    var availableCount = 0;
    var inUseCount = 0;

    (item.evses || []).forEach(function (evse) {
        evseCount++;
        var evseStatus = (evse.status || "").toUpperCase();
        if (isEvseAvailable(evseStatus)) availableCount++;
        else if (isEvseInUse(evseStatus)) inUseCount++;
        // EVSE status is source of truth. Connectors inherit it.
        (evse.connectors || []).forEach(function (c) {
            // Always use EVSE status as the authoritative status for display.
            // The connector-level status is often stale or inconsistent in EcoCarga data.
            var rawStatus = evseStatus || (c.status || "UNKNOWN").toUpperCase();
            connectors.push({
                standard: c.standard || "Desconocido",
                powerType: c.power_type || "N/A",
                maxPower: c.max_electric_power || 0,
                format: c.format || "",
                status: rawStatus
            });
            if (c.max_electric_power > maxPower) maxPower = c.max_electric_power;
        });
    });

    var stds = {}, ptypes = {};
    connectors.forEach(function (c) { stds[c.standard] = true; ptypes[c.powerType] = true; });

    return {
        id: item.location_id,
        name: item.name || "Estacion sin nombre",
        address: item.address || "",
        commune: item.commune || "",
        region: item.region || "",
        lat: parseFloat(item.coordinates.latitude),
        lng: parseFloat(item.coordinates.longitude),
        connectors: connectors,
        standards: Object.keys(stds),
        powerTypes: Object.keys(ptypes),
        maxPower: maxPower,
        evseCount: evseCount,
        availableCount: availableCount,
        inUseCount: inUseCount,
        hasAvailable: availableCount > 0,
        hasInUse: inUseCount > 0,
        is24h: item.opening_times && item.opening_times.twentyfourseven,
        owner: item.owner ? item.owner.name : "Desconocido",
        lastUpdated: item.last_updated,
        _distance: null
    };
}

// ============================================
// Geolocation & Search
// ============================================

function tryGeolocation() {
    if (!navigator.geolocation) { showLoading(false); applyFilters(); return; }
    navigator.geolocation.getCurrentPosition(
        function (pos) {
            state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            state.map.setView([state.userLocation.lat, state.userLocation.lng], 12);
            addUserMarker(state.userLocation.lat, state.userLocation.lng);
            filterByLocation(state.userLocation.lat, state.userLocation.lng);
            showLoading(false);
        },
        function () { showLoading(false); applyFilters(); },
        { timeout: 8000 }
    );
}

function handleSearch() {
    var q = dom.searchInput.value.trim();
    if (q) geocodeSearch(q);
}

function geocodeSearch(query) {
    showLoading(true, "Buscando ubicacion...");
    fetch(NOMINATIM_BASE + "?q=" + encodeURIComponent(query + ", Chile") + "&format=json&limit=1&countrycodes=cl",
        { headers: { "Accept-Language": "es" } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
            if (!res.length) { showLoading(false); dom.resultsList.innerHTML = '<div class="empty-state"><p>No se encontro la ubicacion.</p></div>'; return; }
            var lat = parseFloat(res[0].lat), lng = parseFloat(res[0].lon);
            state.userLocation = { lat: lat, lng: lng };
            state.map.setView([lat, lng], 12);
            addUserMarker(lat, lng);
            filterByLocation(lat, lng);
            showLoading(false);
        })
        .catch(function () { showLoading(false); });
}

function handleGeolocate() {
    if (!navigator.geolocation) { alert("Tu navegador no soporta geolocalizacion."); return; }
    dom.locateBtn.disabled = true;
    showLoading(true, "Obteniendo ubicacion...");
    navigator.geolocation.getCurrentPosition(
        function (pos) {
            var lat = pos.coords.latitude, lng = pos.coords.longitude;
            state.userLocation = { lat: lat, lng: lng };
            state.map.setView([lat, lng], 13);
            addUserMarker(lat, lng);
            filterByLocation(lat, lng);
            dom.locateBtn.disabled = false;
            showLoading(false);
        },
        function () { showLoading(false); dom.locateBtn.disabled = false; alert("No se pudo obtener tu ubicacion."); },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ============================================
// Filtering
// ============================================

function filterByLocation(lat, lng) {
    var radius = parseFloat(dom.radiusRange.value);
    state.stations = state.allStations.map(function (s) { s._distance = haversine(lat, lng, s.lat, s.lng); return s; })
        .filter(function (s) { return s._distance <= radius; });
    state.stations.sort(function (a, b) { return a._distance - b._distance; });
    applyFilters();
}

function getSelectedValues(container) {
    var allCb = container.querySelector('input[value="all"]');
    if (allCb && allCb.checked) return null;
    return Array.from(container.querySelectorAll('input:checked:not([value="all"])')).map(function (cb) { return cb.value; });
}

function applyFilters() {
    var cVals = getSelectedValues(dom.connectorFilters);
    var pVals = getSelectedValues(dom.powerTypeFilters);
    var sVal = dom.statusFilter.value;

    var filtered = state.stations.filter(function (s) {
        if (cVals && !s.standards.some(function (st) { return cVals.indexOf(st) !== -1; })) return false;
        if (pVals && !s.powerTypes.some(function (p) { return pVals.indexOf(p) !== -1; })) return false;
        if (sVal === "available" && !s.hasAvailable) return false;
        if (sVal === "inuse" && !s.hasInUse) return false;
        if (sVal === "unavailable" && (s.hasAvailable || s.hasInUse)) return false;
        return true;
    });

    renderMarkers(filtered);
    renderResultsList(filtered);
}

// ============================================
// Helpers for connector display
// ============================================

function connIcon(standard) { return CONNECTOR_ICONS[standard] || CONN_ICON_DEFAULT; }

function statusCls(status) {
    var s = (status || "").toUpperCase();
    if (isEvseAvailable(s)) return "cs-available";
    if (isEvseInUse(s)) return "cs-inuse";
    return "cs-unavailable";
}

function statusLabel(status) {
    var s = (status || "").toUpperCase();
    if (s === "AVAILABLE" || s === "DISPONIBLE") return "Disponible";
    if (s === "CHARGING" || s === "FINISHING") return "En uso";
    if (s === "RESERVED") return "Reservado";
    if (s === "OUTOFORDER") return "Fuera de servicio";
    if (s === "INOPERATIVE") return "Inoperativo";
    if (s === "BLOCKED") return "Bloqueado";
    if (s === "PLANNED") return "Planificado";
    if (s === "REMOVED") return "Removido";
    // Unknown or any other status — show the raw value for debugging
    return s || "Sin info";
}

// ============================================
// Map Rendering
// ============================================

function renderMarkers(stations) {
    state.markerCluster.clearLayers();
    stations.forEach(function (s) {
        if (!s.lat || !s.lng) return;
        var isDC = s.powerTypes.indexOf("DC") !== -1;
        var cls = "marker-icon";
        if (isDC) cls += " marker-icon-fast";
        if (!s.hasAvailable && s.hasInUse) cls += " marker-icon-inuse";
        else if (!s.hasAvailable) cls += " marker-icon-unavailable";
        var icon = L.divIcon({ html: '<div class="' + cls + '">&#9889;</div>', className: "", iconSize: [32, 32], iconAnchor: [16, 16] });
        var m = L.marker([s.lat, s.lng], { icon: icon });
        m.bindPopup(buildPopup(s), { maxWidth: 340 });
        m.stationId = s.id;
        state.markerCluster.addLayer(m);
    });
}

function buildPopup(s) {
    var h = '<div class="popup-title">' + escapeHtml(s.name) + '</div>';
    h += '<div class="popup-owner">' + escapeHtml(s.owner) + '</div>';
    h += '<div class="popup-address">' + escapeHtml([s.address, s.commune, s.region].filter(Boolean).join(", ")) + '</div>';

    if (s._distance != null) h += '<div class="popup-meta">' + s._distance.toFixed(1) + ' km</div>';

    // Status bar
    var barCls, barTxt;
    if (s.hasAvailable) {
        barCls = "bar-available";
        barTxt = s.availableCount + "/" + s.evseCount + " cargadores disponibles";
    } else if (s.hasInUse) {
        barCls = "bar-inuse";
        barTxt = s.inUseCount + "/" + s.evseCount + " en uso";
    } else {
        barCls = "bar-unavailable";
        barTxt = "Ninguno disponible";
    }
    h += '<div class="popup-status-bar ' + barCls + '">' + barTxt + '</div>';

    // Badges
    if (s.is24h) h += '<span class="tag tag-24h">24/7</span> ';

    // Individual connectors with icons
    h += '<div class="popup-conn-grid">';
    s.connectors.forEach(function (c) {
        var sc = statusCls(c.status);
        var sl = statusLabel(c.status);
        var pw = c.maxPower ? c.maxPower + " kW" : "";
        h += '<div class="popup-conn ' + sc + '">' +
            '<div class="popup-conn-icon">' + connIcon(c.standard) + '</div>' +
            '<div class="popup-conn-detail">' +
            '<div class="popup-conn-type">' + escapeHtml(c.standard) + ' <small>' + c.powerType + '</small></div>' +
            (pw ? '<div class="popup-conn-power">' + pw + '</div>' : '') +
            '</div>' +
            '<div class="popup-conn-badge ' + sc + '">' + sl + '</div>' +
            '</div>';
    });
    h += '</div>';

    if (s.lastUpdated) {
        h += '<div class="popup-meta">Actualizado: ' + new Date(s.lastUpdated).toLocaleDateString("es-CL") + '</div>';
    }

    h += '<a class="popup-directions" href="https://www.google.com/maps/dir/?api=1&destination=' + s.lat + ',' + s.lng + '" target="_blank" rel="noopener">Abrir en Google Maps &rarr;</a>';
    return h;
}

function addUserMarker(lat, lng) {
    if (state.userMarker) state.map.removeLayer(state.userMarker);
    var icon = L.divIcon({ html: '<div class="marker-user"></div>', className: "", iconSize: [20, 20], iconAnchor: [10, 10] });
    state.userMarker = L.marker([lat, lng], { icon: icon, zIndexOffset: 1000 }).addTo(state.map);
    state.userMarker.bindPopup('<div class="popup-title">Tu ubicacion</div>');
}

// ============================================
// Results List
// ============================================

function renderResultsList(stations) {
    dom.resultsCount.textContent = stations.length + " encontrada" + (stations.length !== 1 ? "s" : "");
    if (!stations.length) {
        dom.resultsList.innerHTML = '<div class="empty-state"><p>No se encontraron estaciones.</p></div>';
        return;
    }

    var html = "";
    stations.slice(0, 60).forEach(function (s) {
        var cardCls = s.hasAvailable ? "card-available" : (s.hasInUse ? "card-inuse" : "card-unavailable");

        // Status tag
        var stCls, stTxt;
        if (s.hasAvailable) {
            stCls = "tag-status-available";
            stTxt = s.availableCount + "/" + s.evseCount + " Disp.";
        } else if (s.hasInUse) {
            stCls = "tag-status-inuse";
            stTxt = s.inUseCount + "/" + s.evseCount + " En uso";
        } else {
            stCls = "tag-status-unavailable";
            stTxt = "No disponible";
        }

        // Mini connector icons row
        var miniHtml = '<div class="card-conn-row">';
        s.connectors.forEach(function (c) {
            var sc = statusCls(c.status);
            miniHtml += '<span class="card-conn-mini ' + sc + '" title="' + escapeAttr(c.standard + ' - ' + statusLabel(c.status)) + '">' + connIcon(c.standard) + '</span>';
        });
        miniHtml += '</div>';

        var distHtml = "";
        if (s._distance != null) distHtml = '<span class="station-distance">' + s._distance.toFixed(1) + " km</span>";

        var tagsHtml = '<span class="tag ' + stCls + '">' + stTxt + '</span>';
        s.standards.forEach(function (st) { tagsHtml += '<span class="tag tag-connector">' + escapeHtml(st) + '</span>'; });
        if (s.maxPower > 0) tagsHtml += '<span class="tag tag-power">' + s.maxPower + ' kW</span>';
        if (s.is24h) tagsHtml += '<span class="tag tag-24h">24/7</span>';

        html += '<div class="station-card ' + cardCls + '" data-lat="' + s.lat + '" data-lng="' + s.lng + '" data-id="' + s.id + '">' +
            '<div class="station-card-header"><span class="station-name">' + escapeHtml(s.name) + '</span>' + distHtml + '</div>' +
            '<div class="station-address">' + escapeHtml([s.address, s.commune].filter(Boolean).join(", ")) + '</div>' +
            '<div class="station-owner">' + escapeHtml(s.owner) + '</div>' +
            miniHtml +
            '<div class="station-tags">' + tagsHtml + '</div></div>';
    });

    dom.resultsList.innerHTML = html;

    dom.resultsList.querySelectorAll(".station-card").forEach(function (card) {
        card.addEventListener("click", function () {
            var lat = parseFloat(this.dataset.lat), lng = parseFloat(this.dataset.lng), sid = parseInt(this.dataset.id, 10);
            if (!isNaN(lat) && !isNaN(lng)) {
                state.map.setView([lat, lng], 16);
                state.markerCluster.eachLayer(function (m) { if (m.stationId === sid) m.openPopup(); });
                dom.sidebar.classList.remove("open");
            }
        });
    });
}

// ============================================
// Utilities
// ============================================

function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371, dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(d) { return d * (Math.PI / 180); }

function escapeHtml(s) {
    if (!s) return "";
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
}

function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
}

function showLoading(show, text) {
    dom.loading.classList.toggle("hidden", !show);
    if (text && dom.loadingText) dom.loadingText.textContent = text;
}

// ============================================
// Route Planner
// ============================================

function initPlannerEvents() {
    // Update range estimate on input change
    dom.plannerBattery.addEventListener("input", updateRangeEstimate);
    dom.plannerTerrain.addEventListener("change", updateRangeEstimate);

    // Autocomplete for origin
    dom.plannerOrigin.addEventListener("input", function () {
        plannerAC(dom.plannerOrigin, dom.plannerOriginAC, "origin");
    });
    dom.plannerOrigin.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { closePlannerAC(dom.plannerOriginAC); geocodePlannerField("origin"); }
        if (e.key === "Escape") closePlannerAC(dom.plannerOriginAC);
    });

    // Autocomplete for destination
    dom.plannerDest.addEventListener("input", function () {
        plannerAC(dom.plannerDest, dom.plannerDestAC, "dest");
    });
    dom.plannerDest.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { closePlannerAC(dom.plannerDestAC); geocodePlannerField("dest"); }
        if (e.key === "Escape") closePlannerAC(dom.plannerDestAC);
    });

    // Close autocompletes on outside click
    document.addEventListener("click", function (e) {
        if (!dom.plannerOrigin.contains(e.target) && !dom.plannerOriginAC.contains(e.target))
            closePlannerAC(dom.plannerOriginAC);
        if (!dom.plannerDest.contains(e.target) && !dom.plannerDestAC.contains(e.target))
            closePlannerAC(dom.plannerDestAC);
    });

    // Use my location for origin
    dom.plannerUseLocation.addEventListener("click", function () {
        if (state.userLocation) {
            state.plannerOrigin = { lat: state.userLocation.lat, lng: state.userLocation.lng, name: "Mi ubicacion" };
            dom.plannerOrigin.value = "Mi ubicacion";
            return;
        }
        if (!navigator.geolocation) { alert("Tu navegador no soporta geolocalizacion."); return; }
        dom.plannerUseLocation.disabled = true;
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                state.plannerOrigin = { lat: pos.coords.latitude, lng: pos.coords.longitude, name: "Mi ubicacion" };
                dom.plannerOrigin.value = "Mi ubicacion";
                dom.plannerUseLocation.disabled = false;
            },
            function () { dom.plannerUseLocation.disabled = false; alert("No se pudo obtener tu ubicacion."); },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    });

    // Plan route button
    dom.plannerGo.addEventListener("click", planRoute);
}

function updateRangeEstimate() {
    var battery = parseFloat(dom.plannerBattery.value) || 60;
    var terrainKey = dom.plannerTerrain.value;
    var t = TERRAIN[terrainKey] || TERRAIN.moderate;
    var consumption = t.consumption;
    var rangeKm = Math.round((battery / consumption) * 100);
    dom.plannerRangeKm.textContent = "~" + rangeKm + " km";
    dom.plannerRangeDetail.textContent = battery + " kWh \u00b7 " + t.label + " \u00b7 ~" + consumption + " kWh/100km";
}

// ---- Planner Autocomplete ----

var _plannerDebounce = null;

function plannerAC(inputEl, listEl, which) {
    var v = inputEl.value.trim();
    if (v.length < 2) { closePlannerAC(listEl); return; }
    var ql = v.toLowerCase();
    var matches = state.communes.filter(function (c) {
        return c.name.toLowerCase().indexOf(ql) !== -1 || c.region.toLowerCase().indexOf(ql) !== -1;
    }).slice(0, 3);

    var html = "";
    if (matches.length) {
        html += '<div class="ac-section">Comunas</div>';
        matches.forEach(function (m) {
            html += '<div class="ac-item" data-name="' + escapeAttr(m.name) + '">' +
                '<span class="ac-name">' + hlMatch(m.name, ql) + '</span>' +
                '<span class="ac-meta">' + escapeHtml(m.region) + '</span></div>';
        });
    }
    listEl.innerHTML = html;
    if (html) listEl.classList.remove("hidden");

    bindPlannerACItems(listEl, inputEl, which);

    // Also fetch Nominatim suggestions with debounce
    clearTimeout(_plannerDebounce);
    _plannerDebounce = setTimeout(function () {
        fetchNominatimAC(v, listEl, function () {
            bindPlannerACItems(listEl, inputEl, which);
        });
    }, 350);
}

function bindPlannerACItems(listEl, inputEl, which) {
    listEl.querySelectorAll(".ac-item").forEach(function (it) {
        var clone = it.cloneNode(true);
        it.parentNode.replaceChild(clone, it);
        clone.addEventListener("mousedown", function (e) {
            e.preventDefault();
            var name = this.dataset.name;
            var lat = this.dataset.lat;
            var lng = this.dataset.lng;
            inputEl.value = name;
            closePlannerAC(listEl);
            if (lat && lng) {
                var loc = { lat: parseFloat(lat), lng: parseFloat(lng), name: name };
                if (which === "origin") state.plannerOrigin = loc;
                else state.plannerDest = loc;
            } else {
                geocodePlannerField(which);
            }
        });
    });
}

function closePlannerAC(listEl) {
    listEl.classList.add("hidden");
    listEl.innerHTML = "";
}

function geocodePlannerField(which) {
    var inputEl = which === "origin" ? dom.plannerOrigin : dom.plannerDest;
    var q = inputEl.value.trim();
    if (!q) return;
    fetch(NOMINATIM_BASE + "?q=" + encodeURIComponent(q + ", Chile") + "&format=json&limit=1&countrycodes=cl",
        { headers: { "Accept-Language": "es" } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
            if (!res.length) { alert("No se encontro: " + q); return; }
            var loc = { lat: parseFloat(res[0].lat), lng: parseFloat(res[0].lon), name: res[0].display_name.split(",")[0] };
            if (which === "origin") state.plannerOrigin = loc;
            else state.plannerDest = loc;
        })
        .catch(function () { alert("Error al buscar ubicacion."); });
}

// ---- Route Planning ----

function planRoute() {
    // Validate inputs
    if (!state.plannerOrigin && dom.plannerOrigin.value.trim()) {
        geocodePlannerField("origin");
    }
    if (!state.plannerDest && dom.plannerDest.value.trim()) {
        geocodePlannerField("dest");
    }

    // Give geocoding a moment, then proceed
    setTimeout(doRoutePlan, state.plannerOrigin && state.plannerDest ? 0 : 1200);
}

function doRoutePlan() {
    if (!state.plannerOrigin || !state.plannerDest) {
        alert("Ingresa un origen y un destino validos.");
        return;
    }

    var battery = parseFloat(dom.plannerBattery.value) || 60;
    var terrainKey = dom.plannerTerrain.value;
    var t = TERRAIN[terrainKey] || TERRAIN.moderate;

    dom.plannerGo.disabled = true;
    showLoading(true, "Calculando ruta...");

    var coords = state.plannerOrigin.lng + "," + state.plannerOrigin.lat + ";" + state.plannerDest.lng + "," + state.plannerDest.lat;
    fetch(OSRM_BASE + "/" + coords + "?overview=full&geometries=geojson")
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (!data.routes || !data.routes.length) {
                alert("No se pudo calcular la ruta.");
                showLoading(false);
                dom.plannerGo.disabled = false;
                return;
            }

            var route = data.routes[0];
            var distKm = route.distance / 1000;
            var durationMin = Math.round(route.duration / 60);
            var routeCoords = route.geometry.coordinates; // [lng, lat]

            // Estimate range
            var consumption = t.consumption;
            var rangeKm = (battery / consumption) * 100;

            // Draw route
            clearRoute();
            drawRoute(routeCoords);

            // Find stations along route, prioritizing DC
            var routeStations = findStationsAlongRoute(routeCoords, ROUTE_CORRIDOR_KM);

            // Select recommended stops based on range
            var stops = selectChargingStops(routeStations, routeCoords, rangeKm, distKm);

            // Render results
            renderPlannerResults(distKm, durationMin, rangeKm, battery, t, stops);

            // Add stop markers on map
            addStopMarkers(stops);

            // Fit map to route
            var bounds = state.routeLayer.getBounds().pad(0.1);
            state.map.fitBounds(bounds);

            showLoading(false);
            dom.plannerGo.disabled = false;
        })
        .catch(function (err) {
            console.error("Route error:", err);
            alert("Error al calcular la ruta. Intenta de nuevo.");
            showLoading(false);
            dom.plannerGo.disabled = false;
        });
}

function drawRoute(coords) {
    var latlngs = coords.map(function (c) { return [c[1], c[0]]; });
    state.routeLayer = L.polyline(latlngs, {
        color: "#10b981", weight: 5, opacity: 0.8,
        dashArray: null, lineJoin: "round"
    }).addTo(state.map);

    // Origin marker
    var originIcon = L.divIcon({
        html: '<div style="width:16px;height:16px;border-radius:50%;background:#3b82f6;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>',
        className: "", iconSize: [16, 16], iconAnchor: [8, 8]
    });
    state.originMarker = L.marker(latlngs[0], { icon: originIcon }).addTo(state.map);
    state.originMarker.bindPopup('<div class="popup-title">Origen</div><div class="popup-address">' + escapeHtml(state.plannerOrigin.name) + '</div>');

    // Destination marker
    var destIcon = L.divIcon({
        html: '<div style="width:16px;height:16px;border-radius:50%;background:#ef4444;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>',
        className: "", iconSize: [16, 16], iconAnchor: [8, 8]
    });
    state.destMarker = L.marker(latlngs[latlngs.length - 1], { icon: destIcon }).addTo(state.map);
    state.destMarker.bindPopup('<div class="popup-title">Destino</div><div class="popup-address">' + escapeHtml(state.plannerDest.name) + '</div>');
}

function clearRoute() {
    if (state.routeLayer) { state.map.removeLayer(state.routeLayer); state.routeLayer = null; }
    if (state.originMarker) { state.map.removeLayer(state.originMarker); state.originMarker = null; }
    if (state.destMarker) { state.map.removeLayer(state.destMarker); state.destMarker = null; }
    state.routeStopMarkers.forEach(function (m) { state.map.removeLayer(m); });
    state.routeStopMarkers = [];
}

// ---- Find stations near route ----

function findStationsAlongRoute(routeCoords, corridorKm) {
    // Sample route every ~2km for efficiency
    var samplePoints = [];
    var totalDist = 0;
    for (var i = 0; i < routeCoords.length; i++) {
        if (i === 0) { samplePoints.push({ lat: routeCoords[0][1], lng: routeCoords[0][0], dist: 0 }); continue; }
        totalDist += haversine(routeCoords[i - 1][1], routeCoords[i - 1][0], routeCoords[i][1], routeCoords[i][0]);
        if (samplePoints.length === 0 || totalDist - samplePoints[samplePoints.length - 1].dist >= 2) {
            samplePoints.push({ lat: routeCoords[i][1], lng: routeCoords[i][0], dist: totalDist });
        }
    }

    // For each station, find minimum distance to route
    var results = [];
    state.allStations.forEach(function (s) {
        var minDist = Infinity;
        var nearestRouteDist = 0;
        for (var j = 0; j < samplePoints.length; j++) {
            var d = haversine(s.lat, s.lng, samplePoints[j].lat, samplePoints[j].lng);
            if (d < minDist) {
                minDist = d;
                nearestRouteDist = samplePoints[j].dist;
            }
        }
        if (minDist <= corridorKm) {
            results.push({
                station: s,
                distToRoute: minDist,
                kmAlongRoute: nearestRouteDist,
                isDC: s.powerTypes.indexOf("DC") !== -1
            });
        }
    });

    // Sort by distance along route
    results.sort(function (a, b) { return a.kmAlongRoute - b.kmAlongRoute; });
    return results;
}

function selectChargingStops(routeStations, routeCoords, rangeKm, totalDistKm) {
    // Usable range = 80% of full range (safety margin)
    var usableRange = rangeKm * 0.8;
    var stops = [];
    var currentKm = 0;

    // If total distance is within range, no stops needed
    if (totalDistKm <= usableRange) {
        // Still show available DC stations along the route as optional
        var dcStations = routeStations.filter(function (r) { return r.isDC && r.station.hasAvailable; });
        if (dcStations.length > 0) {
            // Return top 3 DC stations near middle of route as optional stops
            var mid = totalDistKm / 2;
            dcStations.sort(function (a, b) {
                return Math.abs(a.kmAlongRoute - mid) - Math.abs(b.kmAlongRoute - mid);
            });
            return dcStations.slice(0, 3).map(function (r) {
                r.isOptional = true;
                return r;
            });
        }
        return [];
    }

    // Need charging stops
    while (currentKm + usableRange < totalDistKm) {
        var targetKm = currentKm + usableRange;

        // Find best station near target km (prefer DC, available, closer to route)
        var candidates = routeStations.filter(function (r) {
            return r.kmAlongRoute > currentKm + 20 && r.kmAlongRoute <= targetKm + 10;
        });

        if (!candidates.length) {
            // Expand search
            candidates = routeStations.filter(function (r) {
                return r.kmAlongRoute > currentKm + 10;
            });
        }

        if (!candidates.length) break;

        // Score candidates: DC + available = best
        candidates.sort(function (a, b) {
            var scoreA = (a.isDC ? 0 : 100) + (a.station.hasAvailable ? 0 : 50) + a.distToRoute * 5 + Math.abs(a.kmAlongRoute - (currentKm + usableRange * 0.7)) * 0.5;
            var scoreB = (b.isDC ? 0 : 100) + (b.station.hasAvailable ? 0 : 50) + b.distToRoute * 5 + Math.abs(b.kmAlongRoute - (currentKm + usableRange * 0.7)) * 0.5;
            return scoreA - scoreB;
        });

        var best = candidates[0];
        best.isOptional = false;
        stops.push(best);
        currentKm = best.kmAlongRoute;
    }

    return stops;
}

// ---- Render planner results ----

function renderPlannerResults(distKm, durationMin, rangeKm, battery, terrain, stops) {
    var hours = Math.floor(durationMin / 60);
    var mins = durationMin % 60;
    var timeStr = hours > 0 ? hours + "h " + mins + "min" : mins + " min";

    var needsCharge = distKm > rangeKm * 0.8;
    var rangeClass = !needsCharge ? "val-success" : distKm > rangeKm ? "val-danger" : "val-warning";

    var summaryHtml = '<div class="planner-summary-row">' +
        '<span class="planner-summary-label">Distancia total</span>' +
        '<span class="planner-summary-value">' + distKm.toFixed(0) + ' km</span></div>';
    summaryHtml += '<div class="planner-summary-row">' +
        '<span class="planner-summary-label">Tiempo estimado</span>' +
        '<span class="planner-summary-value">' + timeStr + '</span></div>';
    summaryHtml += '<div class="planner-summary-row">' +
        '<span class="planner-summary-label">Autonomia estimada</span>' +
        '<span class="planner-summary-value ' + rangeClass + '">~' + Math.round(rangeKm) + ' km</span></div>';
    summaryHtml += '<div class="planner-summary-row">' +
        '<span class="planner-summary-label">Consumo estimado</span>' +
        '<span class="planner-summary-value">' + (distKm * terrain.consumption / 100).toFixed(1) + ' kWh (' + terrain.consumption + ' kWh/100km)</span></div>';

    if (stops.length > 0 && !stops[0].isOptional) {
        summaryHtml += '<div class="planner-summary-row">' +
            '<span class="planner-summary-label">Paradas necesarias</span>' +
            '<span class="planner-summary-value val-warning">' + stops.length + '</span></div>';
    }

    dom.plannerSummary.innerHTML = summaryHtml;

    // Stops list
    if (stops.length === 0) {
        dom.plannerStopsCount.textContent = "";
        dom.plannerStopsList.innerHTML = '<div class="empty-state"><p>No se necesitan paradas de carga para este recorrido.</p></div>';
    } else {
        var optionalAll = stops.every(function (s) { return s.isOptional; });
        dom.plannerStopsCount.textContent = stops.length + (optionalAll ? " opcionales" : " parada" + (stops.length !== 1 ? "s" : ""));

        var stopsHtml = "";
        stops.forEach(function (stop, i) {
            var s = stop.station;
            var cardCls = stop.isDC ? "stop-dc" : "stop-ac";
            var tagsHtml = "";
            if (stop.isDC) tagsHtml += '<span class="tag tag-power">DC Rapida</span>';
            else tagsHtml += '<span class="tag tag-type">AC Lenta</span>';
            s.standards.forEach(function (st) { tagsHtml += '<span class="tag tag-connector">' + escapeHtml(st) + '</span>'; });
            if (s.maxPower > 0) tagsHtml += '<span class="tag tag-power">' + s.maxPower + ' kW</span>';
            if (s.hasAvailable) tagsHtml += '<span class="tag tag-status-available">Disponible</span>';
            else tagsHtml += '<span class="tag tag-status-unavailable">No disponible</span>';
            if (stop.isOptional) tagsHtml += '<span class="tag tag-24h">Opcional</span>';

            stopsHtml += '<div class="station-card ' + cardCls + ' stop-card" data-lat="' + s.lat + '" data-lng="' + s.lng + '">' +
                '<span class="stop-number">' + (i + 1) + '</span>' +
                '<div class="stop-km">Km ' + Math.round(stop.kmAlongRoute) + ' de la ruta \u00b7 ' + stop.distToRoute.toFixed(1) + ' km del camino</div>' +
                '<div class="stop-name">' + escapeHtml(s.name) + '</div>' +
                '<div class="stop-address">' + escapeHtml([s.address, s.commune].filter(Boolean).join(", ")) + '</div>' +
                '<div class="stop-tags">' + tagsHtml + '</div></div>';
        });

        stopsHtml += '<button class="planner-clear" id="planner-clear-btn">Limpiar ruta</button>';
        dom.plannerStopsList.innerHTML = stopsHtml;

        // Click on stop card => zoom to it
        dom.plannerStopsList.querySelectorAll(".stop-card").forEach(function (card) {
            card.addEventListener("click", function () {
                var lat = parseFloat(this.dataset.lat), lng = parseFloat(this.dataset.lng);
                if (!isNaN(lat) && !isNaN(lng)) {
                    state.map.setView([lat, lng], 15);
                    dom.sidebar.classList.remove("open");
                }
            });
        });

        // Clear route button
        var clearBtn = document.getElementById("planner-clear-btn");
        if (clearBtn) {
            clearBtn.addEventListener("click", function (e) {
                e.stopPropagation();
                clearRoute();
                dom.plannerResults.classList.add("hidden");
                state.plannerOrigin = null;
                state.plannerDest = null;
                dom.plannerOrigin.value = "";
                dom.plannerDest.value = "";
            });
        }
    }

    dom.plannerResults.classList.remove("hidden");
}

function addStopMarkers(stops) {
    stops.forEach(function (stop, i) {
        var color = stop.isDC ? "#f59e0b" : "#3b82f6";
        var icon = L.divIcon({
            html: '<div style="width:28px;height:28px;border-radius:50%;background:' + color + ';border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:' + (stop.isDC ? '#000' : '#fff') + ';font-size:12px;font-weight:700;">' + (i + 1) + '</div>',
            className: "", iconSize: [28, 28], iconAnchor: [14, 14]
        });
        var m = L.marker([stop.station.lat, stop.station.lng], { icon: icon, zIndexOffset: 500 }).addTo(state.map);
        m.bindPopup(buildPopup(stop.station), { maxWidth: 340 });
        state.routeStopMarkers.push(m);
    });
}

// ============================================
document.addEventListener("DOMContentLoaded", init);
