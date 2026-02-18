"use strict";

// ============================================
// ElectroChile - EV Charging Station Finder
// Powered by EcoCarga (Ministerio de Energia)
// ============================================

var ECOCARGA_API = "https://backend.electromovilidadenlinea.cl/locations";
var NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
var CHILE_CENTER = [-33.45, -70.65];
var PAGE_SIZE = 100;

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
    communes: []
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
}

// ============================================
// Init
// ============================================

function init() {
    cacheDom();
    initMap();
    initEvents();
    loadAllStations();
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

function onSearchInput() {
    var v = dom.searchInput.value.trim();
    if (v.length >= 2 && state.communes.length) showAC(v); else closeAC();
}

function showAC(q) {
    var ql = q.toLowerCase();
    var matches = state.communes.filter(function (c) {
        return c.name.toLowerCase().indexOf(ql) !== -1 || c.region.toLowerCase().indexOf(ql) !== -1;
    }).slice(0, 8);
    if (!matches.length) { closeAC(); return; }

    var html = "";
    matches.forEach(function (m, i) {
        html += '<div class="ac-item" data-i="' + i + '" data-name="' + escapeAttr(m.name) + '">' +
            '<span class="ac-name">' + hlMatch(m.name, ql) + '</span>' +
            '<span class="ac-meta">' + escapeHtml(m.region) + ' &middot; ' + m.count + ' est.</span></div>';
    });
    dom.acList.innerHTML = html;
    dom.acList.classList.remove("hidden");

    dom.acList.querySelectorAll(".ac-item").forEach(function (it) {
        it.addEventListener("mousedown", function (e) {
            e.preventDefault();
            dom.searchInput.value = this.dataset.name;
            closeAC();
            geocodeSearch(this.dataset.name);
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
    showLoading(true, "Conectando con EcoCarga...");

    fetchPage(1).then(function (first) {
        var allItems = first.items || [];
        showLoading(true, "Cargando " + first.total_items + " estaciones...");
        if (first.total_pages <= 1) return allItems;
        var p = [];
        for (var i = 2; i <= first.total_pages; i++) p.push(fetchPage(i));
        return Promise.all(p).then(function (pages) {
            pages.forEach(function (pg) { allItems = allItems.concat(pg.items || []); });
            return allItems;
        });
    }).then(function (items) {
        state.allStations = items.map(normalizeStation);
        state.stations = state.allStations.slice();
        buildCommuneIndex();
        dom.dataInfo.textContent = state.allStations.length + " estaciones | EcoCarga";
        tryGeolocation();
    }).catch(function (err) {
        console.error("Error:", err);
        showLoading(false);
        dom.resultsList.innerHTML = '<div class="empty-state"><p>Error al conectar con EcoCarga.</p></div>';
    });
}

function fetchPage(page) {
    return fetch(ECOCARGA_API + "?page=" + page + "&items_per_page=" + PAGE_SIZE)
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
}

function normalizeStation(item) {
    var connectors = [];
    var maxPower = 0;
    var evseCount = 0;
    var availableCount = 0;

    (item.evses || []).forEach(function (evse) {
        evseCount++;
        if (evse.status === "DISPONIBLE") availableCount++;
        (evse.connectors || []).forEach(function (c) {
            connectors.push({
                standard: c.standard || "Desconocido",
                powerType: c.power_type || "N/A",
                maxPower: c.max_electric_power || 0,
                format: c.format || "",
                status: c.status || evse.status || "DESCONOCIDO"
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
        hasAvailable: availableCount > 0,
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
    if (status === "DISPONIBLE") return "cs-available";
    if (status === "EN USO") return "cs-inuse";
    return "cs-unavailable";
}

function statusLabel(status) {
    if (status === "DISPONIBLE") return "Disponible";
    if (status === "EN USO") return "En uso";
    if (status === "FUERA DE SERVICIO") return "Fuera de servicio";
    return "No disponible";
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
        if (!s.hasAvailable) cls += " marker-icon-unavailable";
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
    var barCls = s.hasAvailable ? "bar-available" : "bar-unavailable";
    var barTxt = s.hasAvailable ? s.availableCount + "/" + s.evseCount + " cargadores disponibles" : "Ninguno disponible";
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
        var cardCls = s.hasAvailable ? "card-available" : "card-unavailable";

        // Status tag
        var stCls = s.hasAvailable ? "tag-status-available" : "tag-status-unavailable";
        var stTxt = s.hasAvailable ? s.availableCount + "/" + s.evseCount + " Disp." : "No disponible";

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
document.addEventListener("DOMContentLoaded", init);
