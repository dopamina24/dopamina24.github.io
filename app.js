"use strict";

// ============================================
// ElectroChile - EV Charging Station Finder
// ============================================

const OCM_API_BASE = "https://api.openchargemap.io/v3/poi/";
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
const CHILE_CENTER = [-33.45, -70.65]; // Santiago
const CHILE_BOUNDS = [[-56.0, -75.7], [-17.5, -66.4]];
const STORAGE_KEY = "electrochile_api_key";

// Connector type names for display
const CONNECTOR_NAMES = {
    1: "Tipo 1 (J1772)",
    2: "CHAdeMO",
    25: "Tipo 2 (Mennekes)",
    33: "CCS (Tipo 2)",
    0: "Desconocido"
};

const LEVEL_NAMES = {
    1: "Nivel 1 (Lento)",
    2: "Nivel 2 (AC)",
    3: "Nivel 3 (DC Rapido)"
};

// ---- App State ----
const state = {
    map: null,
    markerCluster: null,
    userMarker: null,
    stations: [],
    userLocation: null,
    apiKey: localStorage.getItem(STORAGE_KEY) || ""
};

// ---- DOM Elements ----
const dom = {
    searchInput: document.getElementById("search-input"),
    searchBtn: document.getElementById("search-btn"),
    locateBtn: document.getElementById("locate-btn"),
    radiusRange: document.getElementById("radius-range"),
    radiusValue: document.getElementById("radius-value"),
    connectorFilters: document.getElementById("connector-filters"),
    levelFilters: document.getElementById("level-filters"),
    resultsList: document.getElementById("results-list"),
    resultsCount: document.getElementById("results-count"),
    loading: document.getElementById("loading"),
    sidebar: document.getElementById("sidebar"),
    sidebarToggle: document.getElementById("sidebar-toggle"),
    sidebarClose: document.getElementById("sidebar-close"),
    apiKeyModal: document.getElementById("api-key-modal"),
    apiKeyInput: document.getElementById("api-key-input"),
    saveApiKey: document.getElementById("save-api-key"),
    skipApiKey: document.getElementById("skip-api-key")
};

// ============================================
// Initialization
// ============================================

function init() {
    initMap();
    initEvents();
    checkApiKey();
}

function initMap() {
    state.map = L.map("map", {
        center: CHILE_CENTER,
        zoom: 6,
        maxBounds: [[-60, -80], [-15, -60]],
        minZoom: 4
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
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
            fetchStations(state.userLocation.lat, state.userLocation.lng);
        }
    });

    // Connector filter: "Todos" toggle logic
    dom.connectorFilters.addEventListener("change", function (e) {
        handleFilterToggle(e, dom.connectorFilters);
    });

    dom.levelFilters.addEventListener("change", function (e) {
        handleFilterToggle(e, dom.levelFilters);
    });

    // Mobile sidebar
    dom.sidebarToggle.addEventListener("click", function () {
        dom.sidebar.classList.add("open");
    });
    dom.sidebarClose.addEventListener("click", function () {
        dom.sidebar.classList.remove("open");
    });

    // API Key modal
    dom.saveApiKey.addEventListener("click", function () {
        var key = dom.apiKeyInput.value.trim();
        if (key) {
            state.apiKey = key;
            localStorage.setItem(STORAGE_KEY, key);
            dom.apiKeyModal.classList.add("hidden");
            loadInitialData();
        }
    });
    dom.skipApiKey.addEventListener("click", function () {
        dom.apiKeyModal.classList.add("hidden");
        loadInitialData();
    });
    dom.apiKeyInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") dom.saveApiKey.click();
    });
}

function handleFilterToggle(e, container) {
    var target = e.target;
    if (target.type !== "checkbox") return;

    var allCheckbox = container.querySelector('input[value="all"]');
    var others = container.querySelectorAll('input:not([value="all"])');

    if (target.value === "all") {
        others.forEach(function (cb) { cb.checked = false; });
        allCheckbox.checked = true;
    } else {
        allCheckbox.checked = false;
        var anyChecked = Array.from(others).some(function (cb) { return cb.checked; });
        if (!anyChecked) {
            allCheckbox.checked = true;
        }
    }

    applyFilters();
}

function checkApiKey() {
    if (state.apiKey) {
        dom.apiKeyModal.classList.add("hidden");
        loadInitialData();
    } else {
        dom.apiKeyModal.classList.remove("hidden");
    }
}

function loadInitialData() {
    // Try geolocation first, fall back to showing all Chile
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                state.map.setView([state.userLocation.lat, state.userLocation.lng], 12);
                addUserMarker(state.userLocation.lat, state.userLocation.lng);
                fetchStations(state.userLocation.lat, state.userLocation.lng);
            },
            function () {
                fetchStationsCountryWide();
            },
            { timeout: 8000 }
        );
    } else {
        fetchStationsCountryWide();
    }
}

// ============================================
// API Calls
// ============================================

function fetchStations(lat, lng) {
    var radius = dom.radiusRange.value;
    showLoading(true);

    var url = OCM_API_BASE +
        "?output=json" +
        "&countrycode=CL" +
        "&latitude=" + lat +
        "&longitude=" + lng +
        "&distance=" + radius +
        "&distanceunit=KM" +
        "&maxresults=500" +
        "&compact=true" +
        "&verbose=false";

    if (state.apiKey) {
        url += "&key=" + encodeURIComponent(state.apiKey);
    }

    fetch(url)
        .then(function (res) {
            if (!res.ok) throw new Error("Error " + res.status);
            return res.json();
        })
        .then(function (data) {
            state.stations = data || [];
            state.stations.forEach(function (s) {
                if (s.AddressInfo) {
                    s._distance = haversine(lat, lng, s.AddressInfo.Latitude, s.AddressInfo.Longitude);
                }
            });
            state.stations.sort(function (a, b) { return (a._distance || 999) - (b._distance || 999); });
            applyFilters();
        })
        .catch(function (err) {
            console.error("Error fetching stations:", err);
            dom.resultsList.innerHTML = '<div class="empty-state"><p>Error al buscar estaciones. Verifica tu API key o intenta de nuevo.</p></div>';
        })
        .finally(function () {
            showLoading(false);
        });
}

function fetchStationsCountryWide() {
    showLoading(true);

    var url = OCM_API_BASE +
        "?output=json" +
        "&countrycode=CL" +
        "&maxresults=1000" +
        "&compact=true" +
        "&verbose=false";

    if (state.apiKey) {
        url += "&key=" + encodeURIComponent(state.apiKey);
    }

    fetch(url)
        .then(function (res) {
            if (!res.ok) throw new Error("Error " + res.status);
            return res.json();
        })
        .then(function (data) {
            state.stations = data || [];
            applyFilters();
        })
        .catch(function (err) {
            console.error("Error fetching stations:", err);
            dom.resultsList.innerHTML = '<div class="empty-state"><p>Error al cargar estaciones. Verifica tu conexion.</p></div>';
        })
        .finally(function () {
            showLoading(false);
        });
}

function geocodeSearch(query) {
    showLoading(true);

    var url = NOMINATIM_BASE +
        "?q=" + encodeURIComponent(query + ", Chile") +
        "&format=json" +
        "&limit=1" +
        "&countrycodes=cl";

    fetch(url, {
        headers: { "Accept-Language": "es" }
    })
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
            fetchStations(lat, lng);
        })
        .catch(function (err) {
            console.error("Geocode error:", err);
            showLoading(false);
        });
}

// ============================================
// Search & Geolocation Handlers
// ============================================

function handleSearch() {
    var query = dom.searchInput.value.trim();
    if (!query) return;
    geocodeSearch(query);
}

function handleGeolocate() {
    if (!navigator.geolocation) {
        alert("Tu navegador no soporta geolocalizacion.");
        return;
    }

    dom.locateBtn.disabled = true;
    showLoading(true);

    navigator.geolocation.getCurrentPosition(
        function (pos) {
            var lat = pos.coords.latitude;
            var lng = pos.coords.longitude;
            state.userLocation = { lat: lat, lng: lng };
            state.map.setView([lat, lng], 13);
            addUserMarker(lat, lng);
            fetchStations(lat, lng);
            dom.locateBtn.disabled = false;
        },
        function (err) {
            showLoading(false);
            dom.locateBtn.disabled = false;
            alert("No se pudo obtener tu ubicacion. Asegurate de tener los permisos activados.");
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ============================================
// Filtering
// ============================================

function getSelectedValues(container) {
    var allCheckbox = container.querySelector('input[value="all"]');
    if (allCheckbox && allCheckbox.checked) return null; // null = all

    var checked = container.querySelectorAll('input:checked:not([value="all"])');
    return Array.from(checked).map(function (cb) { return parseInt(cb.value, 10); });
}

function applyFilters() {
    var connectorValues = getSelectedValues(dom.connectorFilters);
    var levelValues = getSelectedValues(dom.levelFilters);

    var filtered = state.stations.filter(function (station) {
        if (!station.Connections || station.Connections.length === 0) return true;

        var matchConnector = !connectorValues || station.Connections.some(function (c) {
            return connectorValues.indexOf(c.ConnectionTypeID) !== -1;
        });

        var matchLevel = !levelValues || station.Connections.some(function (c) {
            return levelValues.indexOf(c.LevelID) !== -1;
        });

        return matchConnector && matchLevel;
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
        var addr = station.AddressInfo;
        if (!addr || !addr.Latitude || !addr.Longitude) return;

        var isFast = station.Connections && station.Connections.some(function (c) {
            return c.LevelID === 3;
        });

        var icon = L.divIcon({
            html: '<div class="marker-icon ' + (isFast ? "marker-icon-fast" : "") + '">&#9889;</div>',
            className: "",
            iconSize: [32, 32],
            iconAnchor: [16, 16]
        });

        var marker = L.marker([addr.Latitude, addr.Longitude], { icon: icon });
        marker.bindPopup(buildPopupContent(station));

        marker.stationId = station.ID;
        state.markerCluster.addLayer(marker);
    });
}

function buildPopupContent(station) {
    var addr = station.AddressInfo || {};
    var title = escapeHtml(addr.Title || "Estacion sin nombre");
    var address = escapeHtml([addr.AddressLine1, addr.Town, addr.StateOrProvince].filter(Boolean).join(", "));

    var connectorsHtml = "";
    if (station.Connections && station.Connections.length > 0) {
        connectorsHtml = '<div class="popup-connectors">';
        station.Connections.forEach(function (c) {
            var name = CONNECTOR_NAMES[c.ConnectionTypeID] || "Conector #" + c.ConnectionTypeID;
            var power = c.PowerKW ? c.PowerKW + " kW" : "N/A";
            var qty = c.Quantity ? " x" + c.Quantity : "";
            connectorsHtml += '<div class="popup-connector"><span>' + escapeHtml(name) + qty + '</span><span>' + escapeHtml(power) + '</span></div>';
        });
        connectorsHtml += "</div>";
    }

    var distanceText = "";
    if (station._distance !== undefined) {
        distanceText = '<div style="font-size:0.75rem;color:#94a3b8;margin-bottom:6px;">' + station._distance.toFixed(1) + ' km de distancia</div>';
    }

    var directionsUrl = "https://www.google.com/maps/dir/?api=1&destination=" + addr.Latitude + "," + addr.Longitude;

    return '<div class="popup-title">' + title + "</div>" +
        '<div class="popup-address">' + address + "</div>" +
        distanceText +
        connectorsHtml +
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
    // Show max 50 in the sidebar list for performance
    var displayStations = stations.slice(0, 50);

    displayStations.forEach(function (station) {
        var addr = station.AddressInfo || {};
        var name = escapeHtml(addr.Title || "Estacion sin nombre");
        var address = escapeHtml([addr.AddressLine1, addr.Town].filter(Boolean).join(", "));

        var distanceHtml = "";
        if (station._distance !== undefined) {
            distanceHtml = '<span class="station-distance">' + station._distance.toFixed(1) + " km</span>";
        }

        var tagsHtml = "";
        if (station.Connections) {
            var seenConnectors = {};
            var maxPower = 0;
            station.Connections.forEach(function (c) {
                var cName = CONNECTOR_NAMES[c.ConnectionTypeID];
                if (cName && !seenConnectors[cName]) {
                    seenConnectors[cName] = true;
                    tagsHtml += '<span class="tag tag-connector">' + escapeHtml(cName) + "</span>";
                }
                if (c.PowerKW && c.PowerKW > maxPower) maxPower = c.PowerKW;
            });
            if (maxPower > 0) {
                tagsHtml += '<span class="tag tag-power">' + maxPower + " kW</span>";
            }
        }

        var statusClass = station.StatusTypeID === 50 ? "tag-status-operational" : "tag-status-unknown";
        var statusText = station.StatusTypeID === 50 ? "Operativa" : "Estado desconocido";
        tagsHtml += '<span class="tag ' + statusClass + '">' + statusText + "</span>";

        html += '<div class="station-card" data-lat="' + (addr.Latitude || "") + '" data-lng="' + (addr.Longitude || "") + '" data-id="' + station.ID + '">' +
            '<div class="station-card-header">' +
            '<span class="station-name">' + name + "</span>" +
            distanceHtml +
            "</div>" +
            '<div class="station-address">' + address + "</div>" +
            '<div class="station-tags">' + tagsHtml + "</div>" +
            "</div>";
    });

    dom.resultsList.innerHTML = html;

    // Click handlers for station cards
    dom.resultsList.querySelectorAll(".station-card").forEach(function (card) {
        card.addEventListener("click", function () {
            var lat = parseFloat(this.dataset.lat);
            var lng = parseFloat(this.dataset.lng);
            var stationId = parseInt(this.dataset.id, 10);

            if (!isNaN(lat) && !isNaN(lng)) {
                state.map.setView([lat, lng], 16);

                // Open the popup for this station
                state.markerCluster.eachLayer(function (marker) {
                    if (marker.stationId === stationId) {
                        marker.openPopup();
                    }
                });

                // Close sidebar on mobile
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
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRad(deg) {
    return deg * (Math.PI / 180);
}

function escapeHtml(str) {
    if (!str) return "";
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function showLoading(show) {
    dom.loading.classList.toggle("hidden", !show);
}

// ============================================
// Start
// ============================================
document.addEventListener("DOMContentLoaded", init);
