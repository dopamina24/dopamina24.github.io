"use strict";

// ============================================
// ElectroChile - EV Charging Station Finder
// Powered by EcoCarga (Ministerio de Energia)
// ============================================

var ECOCARGA_API = "https://backend.electromovilidadenlinea.cl/locations";
var NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
var CHILE_CENTER = [-33.45, -70.65];
var PAGE_SIZE = 100;

// Status display config
var STATUS_CONFIG = {
    "DISPONIBLE": { label: "Disponible", cls: "status-available" },
    "NO DISPONIBLE": { label: "No disponible", cls: "status-unavailable" },
    "EN USO": { label: "En uso", cls: "status-in-use" },
    "FUERA DE SERVICIO": { label: "Fuera de servicio", cls: "status-offline" }
};

// ---- App State ----
var state = {
    map: null,
    markerCluster: null,
    userMarker: null,
    allStations: [],
    stations: [],
    userLocation: null
};

// ---- DOM Elements ----
var dom = {};

function cacheDom() {
    dom.searchInput = document.getElementById("search-input");
    dom.searchBtn = document.getElementById("search-btn");
    dom.locateBtn = document.getElementById("locate-btn");
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
// Initialization
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
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | Datos: <a href="https://energia.gob.cl/electromovilidad/ecocarga" target="_blank">EcoCarga MinEnergia</a>',
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
        if (e.key === "Enter") handleSearch();
    });

    dom.locateBtn.addEventListener("click", handleGeolocate);

    dom.radiusRange.addEventListener("input", function () {
        dom.radiusValue.textContent = this.value + " km";
    });
    dom.radiusRange.addEventListener("change", function () {
        if (state.userLocation) {
            filterByLocation(state.userLocation.lat, state.userLocation.lng);
        }
    });

    dom.connectorFilters.addEventListener("change", function (e) {
        handleFilterToggle(e, dom.connectorFilters);
    });
    dom.powerTypeFilters.addEventListener("change", function (e) {
        handleFilterToggle(e, dom.powerTypeFilters);
    });

    dom.statusFilter.addEventListener("change", applyFilters);

    dom.sidebarToggle.addEventListener("click", function () {
        dom.sidebar.classList.add("open");
    });
    dom.sidebarClose.addEventListener("click", function () {
        dom.sidebar.classList.remove("open");
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
        var anyChecked = Array.from(others).some(function (cb) { return cb.checked; });
        if (!anyChecked) allCb.checked = true;
    }

    applyFilters();
}

// ============================================
// Data Loading - EcoCarga API
// ============================================

function loadAllStations() {
    showLoading(true, "Conectando con EcoCarga...");

    fetchPage(1)
        .then(function (first) {
            var totalPages = first.total_pages;
            var allItems = first.items || [];

            showLoading(true, "Cargando " + first.total_items + " estaciones...");

            if (totalPages <= 1) return allItems;

            // Fetch remaining pages in parallel
            var promises = [];
            for (var i = 2; i <= totalPages; i++) {
                promises.push(fetchPage(i));
            }

            return Promise.all(promises).then(function (pages) {
                pages.forEach(function (p) {
                    allItems = allItems.concat(p.items || []);
                });
                return allItems;
            });
        })
        .then(function (items) {
            state.allStations = items.map(normalizeStation);
            state.stations = state.allStations.slice();

            dom.dataInfo.textContent = state.allStations.length + " estaciones | EcoCarga";

            // Try geolocation, then show results
            tryGeolocation();
        })
        .catch(function (err) {
            console.error("Error loading stations:", err);
            showLoading(false);
            dom.resultsList.innerHTML =
                '<div class="empty-state">' +
                '<p>Error al conectar con EcoCarga.</p>' +
                '<p style="font-size:0.75rem;margin-top:8px;color:var(--text-muted);">Es posible que la API tenga restricciones CORS. Intenta recargar la pagina.</p>' +
                '</div>';
        });
}

function fetchPage(page) {
    var url = ECOCARGA_API + "?page=" + page + "&items_per_page=" + PAGE_SIZE;
    return fetch(url).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
    });
}

// Normalize EcoCarga item into our internal model
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

    // Unique standards and power types
    var stds = {};
    var ptypes = {};
    connectors.forEach(function (c) {
        stds[c.standard] = true;
        ptypes[c.powerType] = true;
    });

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
        ownerPhone: item.owner ? item.owner.phone : null,
        parkingType: item.parking_type || "",
        installationType: item.charging_instalation_type || "",
        lastUpdated: item.last_updated,
        _distance: null
    };
}

// ============================================
// Geolocation & Search
// ============================================

function tryGeolocation() {
    if (!navigator.geolocation) {
        showLoading(false);
        applyFilters();
        return;
    }

    navigator.geolocation.getCurrentPosition(
        function (pos) {
            state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            state.map.setView([state.userLocation.lat, state.userLocation.lng], 12);
            addUserMarker(state.userLocation.lat, state.userLocation.lng);
            filterByLocation(state.userLocation.lat, state.userLocation.lng);
            showLoading(false);
        },
        function () {
            showLoading(false);
            applyFilters();
        },
        { timeout: 8000 }
    );
}

function handleSearch() {
    var query = dom.searchInput.value.trim();
    if (!query) return;
    geocodeSearch(query);
}

function geocodeSearch(query) {
    showLoading(true, "Buscando ubicacion...");

    var url = NOMINATIM_BASE +
        "?q=" + encodeURIComponent(query + ", Chile") +
        "&format=json&limit=1&countrycodes=cl";

    fetch(url, { headers: { "Accept-Language": "es" } })
        .then(function (res) { return res.json(); })
        .then(function (results) {
            if (results.length === 0) {
                showLoading(false);
                dom.resultsList.innerHTML = '<div class="empty-state"><p>No se encontro la ubicacion. Intenta con otro termino.</p></div>';
                return;
            }

            var place = results[0];
            var lat = parseFloat(place.lat);
            var lng = parseFloat(place.lon);

            state.userLocation = { lat: lat, lng: lng };
            state.map.setView([lat, lng], 12);
            addUserMarker(lat, lng);
            filterByLocation(lat, lng);
            showLoading(false);
        })
        .catch(function (err) {
            console.error("Geocode error:", err);
            showLoading(false);
        });
}

function handleGeolocate() {
    if (!navigator.geolocation) {
        alert("Tu navegador no soporta geolocalizacion.");
        return;
    }

    dom.locateBtn.disabled = true;
    showLoading(true, "Obteniendo ubicacion...");

    navigator.geolocation.getCurrentPosition(
        function (pos) {
            var lat = pos.coords.latitude;
            var lng = pos.coords.longitude;
            state.userLocation = { lat: lat, lng: lng };
            state.map.setView([lat, lng], 13);
            addUserMarker(lat, lng);
            filterByLocation(lat, lng);
            dom.locateBtn.disabled = false;
            showLoading(false);
        },
        function () {
            showLoading(false);
            dom.locateBtn.disabled = false;
            alert("No se pudo obtener tu ubicacion.");
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ============================================
// Filtering
// ============================================

function filterByLocation(lat, lng) {
    var radius = parseFloat(dom.radiusRange.value);

    state.stations = state.allStations.map(function (s) {
        s._distance = haversine(lat, lng, s.lat, s.lng);
        return s;
    }).filter(function (s) {
        return s._distance <= radius;
    });

    state.stations.sort(function (a, b) { return a._distance - b._distance; });
    applyFilters();
}

function getSelectedValues(container) {
    var allCb = container.querySelector('input[value="all"]');
    if (allCb && allCb.checked) return null;

    var checked = container.querySelectorAll('input:checked:not([value="all"])');
    return Array.from(checked).map(function (cb) { return cb.value; });
}

function applyFilters() {
    var connectorVals = getSelectedValues(dom.connectorFilters);
    var powerVals = getSelectedValues(dom.powerTypeFilters);
    var statusVal = dom.statusFilter.value;

    var filtered = state.stations.filter(function (s) {
        // Connector standard filter
        if (connectorVals) {
            var match = s.standards.some(function (std) {
                return connectorVals.indexOf(std) !== -1;
            });
            if (!match) return false;
        }

        // Power type filter (AC/DC)
        if (powerVals) {
            var matchP = s.powerTypes.some(function (p) {
                return powerVals.indexOf(p) !== -1;
            });
            if (!matchP) return false;
        }

        // Status filter
        if (statusVal === "available" && !s.hasAvailable) return false;

        return true;
    });

    renderMarkers(filtered);
    renderResultsList(filtered);
}

// ============================================
// Map Rendering
// ============================================

function renderMarkers(stations) {
    state.markerCluster.clearLayers();

    stations.forEach(function (station) {
        if (!station.lat || !station.lng) return;

        var isDC = station.powerTypes.indexOf("DC") !== -1;

        var cls = "marker-icon";
        if (isDC) cls += " marker-icon-fast";
        if (!station.hasAvailable) cls += " marker-icon-unavailable";

        var icon = L.divIcon({
            html: '<div class="' + cls + '">&#9889;</div>',
            className: "",
            iconSize: [32, 32],
            iconAnchor: [16, 16]
        });

        var marker = L.marker([station.lat, station.lng], { icon: icon });
        marker.bindPopup(buildPopupContent(station), { maxWidth: 300 });
        marker.stationId = station.id;
        state.markerCluster.addLayer(marker);
    });
}

function buildPopupContent(station) {
    var title = escapeHtml(station.name);
    var address = escapeHtml([station.address, station.commune, station.region].filter(Boolean).join(", "));

    // Owner
    var ownerHtml = '<div class="popup-owner">' + escapeHtml(station.owner) + '</div>';

    // Status summary
    var statusCls = station.hasAvailable ? "status-available" : "status-unavailable";
    var statusLabel = station.hasAvailable
        ? station.availableCount + "/" + station.evseCount + " disponibles"
        : "No disponible";
    var statusHtml = '<div class="popup-status"><span class="status-dot ' + statusCls + '"></span> ' + statusLabel + '</div>';

    // Distance
    var distHtml = "";
    if (station._distance !== null && station._distance !== undefined) {
        distHtml = '<div class="popup-meta">' + station._distance.toFixed(1) + ' km de distancia</div>';
    }

    // 24/7 + installation type
    var badgesHtml = "";
    if (station.is24h) badgesHtml += '<span class="tag tag-24h">24/7</span> ';
    if (station.installationType) badgesHtml += '<span class="tag tag-type">' + escapeHtml(station.installationType) + '</span>';
    if (badgesHtml) badgesHtml = '<div class="popup-badges">' + badgesHtml + '</div>';

    // Connectors grouped by standard + power type
    var grouped = {};
    station.connectors.forEach(function (c) {
        var key = c.standard + "|" + c.powerType;
        if (!grouped[key]) {
            grouped[key] = { standard: c.standard, powerType: c.powerType, maxPower: c.maxPower, count: 0 };
        }
        grouped[key].count++;
        if (c.maxPower > grouped[key].maxPower) grouped[key].maxPower = c.maxPower;
    });

    var connectorsHtml = '<div class="popup-connectors">';
    Object.keys(grouped).forEach(function (key) {
        var g = grouped[key];
        var label = escapeHtml(g.standard) + " (" + g.powerType + ") x" + g.count;
        var power = g.maxPower ? g.maxPower + " kW" : "N/A";
        connectorsHtml += '<div class="popup-connector"><span>' + label + '</span><span>' + power + '</span></div>';
    });
    connectorsHtml += "</div>";

    // Last updated
    var updatedHtml = "";
    if (station.lastUpdated) {
        var d = new Date(station.lastUpdated);
        updatedHtml = '<div class="popup-meta">Actualizado: ' + d.toLocaleDateString("es-CL") + '</div>';
    }

    var directionsUrl = "https://www.google.com/maps/dir/?api=1&destination=" + station.lat + "," + station.lng;

    return '<div class="popup-title">' + title + '</div>' +
        ownerHtml +
        '<div class="popup-address">' + address + '</div>' +
        distHtml +
        statusHtml +
        badgesHtml +
        connectorsHtml +
        updatedHtml +
        '<a class="popup-directions" href="' + directionsUrl + '" target="_blank" rel="noopener">Abrir en Google Maps &rarr;</a>';
}

function addUserMarker(lat, lng) {
    if (state.userMarker) {
        state.map.removeLayer(state.userMarker);
    }

    var icon = L.divIcon({
        html: '<div class="marker-user"></div>',
        className: "",
        iconSize: [20, 20],
        iconAnchor: [10, 10]
    });

    state.userMarker = L.marker([lat, lng], { icon: icon, zIndexOffset: 1000 });
    state.userMarker.addTo(state.map);
    state.userMarker.bindPopup('<div class="popup-title">Tu ubicacion</div>');
}

// ============================================
// Results List
// ============================================

function renderResultsList(stations) {
    dom.resultsCount.textContent = stations.length + " encontrada" + (stations.length !== 1 ? "s" : "");

    if (stations.length === 0) {
        dom.resultsList.innerHTML = '<div class="empty-state"><p>No se encontraron estaciones con los filtros actuales.</p></div>';
        return;
    }

    var html = "";
    var display = stations.slice(0, 60);

    display.forEach(function (station) {
        var name = escapeHtml(station.name);
        var addr = escapeHtml([station.address, station.commune].filter(Boolean).join(", "));

        var distHtml = "";
        if (station._distance !== null && station._distance !== undefined) {
            distHtml = '<span class="station-distance">' + station._distance.toFixed(1) + " km</span>";
        }

        // Status tag
        var stCls = station.hasAvailable ? "tag-status-available" : "tag-status-unavailable";
        var stTxt = station.hasAvailable ? station.availableCount + "/" + station.evseCount + " Disp." : "No disponible";

        var tagsHtml = '<span class="tag ' + stCls + '">' + stTxt + '</span>';

        station.standards.forEach(function (std) {
            tagsHtml += '<span class="tag tag-connector">' + escapeHtml(std) + '</span>';
        });

        if (station.maxPower > 0) {
            tagsHtml += '<span class="tag tag-power">' + station.maxPower + ' kW</span>';
        }

        if (station.is24h) {
            tagsHtml += '<span class="tag tag-24h">24/7</span>';
        }

        var ownerHtml = '<div class="station-owner">' + escapeHtml(station.owner) + '</div>';

        html += '<div class="station-card" data-lat="' + station.lat + '" data-lng="' + station.lng + '" data-id="' + station.id + '">' +
            '<div class="station-card-header">' +
            '<span class="station-name">' + name + '</span>' +
            distHtml +
            '</div>' +
            '<div class="station-address">' + addr + '</div>' +
            ownerHtml +
            '<div class="station-tags">' + tagsHtml + '</div>' +
            '</div>';
    });

    dom.resultsList.innerHTML = html;

    dom.resultsList.querySelectorAll(".station-card").forEach(function (card) {
        card.addEventListener("click", function () {
            var lat = parseFloat(this.dataset.lat);
            var lng = parseFloat(this.dataset.lng);
            var sid = parseInt(this.dataset.id, 10);

            if (!isNaN(lat) && !isNaN(lng)) {
                state.map.setView([lat, lng], 16);
                state.markerCluster.eachLayer(function (m) {
                    if (m.stationId === sid) m.openPopup();
                });
                dom.sidebar.classList.remove("open");
            }
        });
    });
}

// ============================================
// Utilities
// ============================================

function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) {
    return deg * (Math.PI / 180);
}

function escapeHtml(str) {
    if (!str) return "";
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
}

function showLoading(show, text) {
    dom.loading.classList.toggle("hidden", !show);
    if (text && dom.loadingText) dom.loadingText.textContent = text;
}

// ============================================
// Start
// ============================================
document.addEventListener("DOMContentLoaded", init);
