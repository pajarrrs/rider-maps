(() => {
  const OSRM = {
    car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
    // OSM public servers have no motorcycle profile; car is the closest road network.
    motorcycle: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
    bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving',
    foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving',
  };
  const TT_MODE = { car: 'car', motorcycle: 'motorcycle', bike: 'bicycle', foot: 'pedestrian' };
  const TOMTOM_KEY = 'bW6TSMY0rQsoWZYyCUjxnkmJrRBOzyiG';
  const PHOTON = 'https://photon.komoot.io';
  const TRAFFIC_COLORS = ['#22c55e', '#eab308', '#f97316', '#ef4444', '#7f1d1d'];

  const $ = (id) => document.getElementById(id);
  const state = { from: null, to: null, routes: [], active: 0 };

  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [106.8456, -6.2088],
    zoom: 12,
    pitch: 0,
    bearing: 0,
    maxPitch: 75,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  const markers = {
    from: makeMarker('#22c55e', 'from'),
    to: makeMarker('#ef4444', 'to'),
  };

  function makeMarker(color, key) {
    const m = new maplibregl.Marker({ color, draggable: true });
    m.on('dragend', async () => {
      const { lng, lat } = m.getLngLat();
      await setPoint(key, { lng, lat }, null);
      if (state.from && state.to) findRoute();
    });
    return m;
  }

  map.on('load', () => {
    ensureBuildings3d();
    map.addSource('routes', { type: 'geojson', data: emptyFC() });
    map.addSource('traffic', { type: 'geojson', data: emptyFC() });

    // Satellite imagery and hybrid labels (ArcGIS)
    map.addSource('satellite-base', {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
    });
    map.addSource('satellite-roads', {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
    });
    map.addSource('satellite-labels', {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
    });

    map.addLayer({
      id: 'satellite-base', type: 'raster', source: 'satellite-base',
      layout: { visibility: 'none' },
    });
    map.addLayer({
      id: 'satellite-roads', type: 'raster', source: 'satellite-roads',
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 0.85 },
    });
    map.addLayer({
      id: 'satellite-labels', type: 'raster', source: 'satellite-labels',
      layout: { visibility: 'none' },
    });

    map.addLayer({
      id: 'routes-alt', type: 'line', source: 'routes',
      filter: ['!=', ['get', 'active'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#94a3b8', 'line-width': 6, 'line-opacity': 0.75 },
    });
    map.addLayer({
      id: 'route-casing', type: 'line', source: 'routes',
      filter: ['==', ['get', 'active'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#1e3a8a', 'line-width': 10 },
    });
    map.addLayer({
      id: 'route-active', type: 'line', source: 'routes',
      filter: ['==', ['get', 'active'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#3b82f6', 'line-width': 6 },
    });
    map.addLayer({
      id: 'route-traffic', type: 'line', source: 'traffic',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 6 },
    });

    map.on('click', 'routes-alt', (e) => {
      const idx = e.features[0]?.properties?.idx;
      if (idx !== undefined) selectRoute(Number(idx));
    });
    map.on('mouseenter', 'routes-alt', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'routes-alt', () => (map.getCanvas().style.cursor = ''));

    if ($('toggleTraffic').checked) setTrafficLayer(true);
    if ($('toggleSatellite')?.checked) setSatellite(true);
  });

  // OpenFreeMap "liberty" ships a building-3d layer; add one if a future style drops it.
  function ensureBuildings3d() {
    if (!map.getLayer('building-3d') && map.getSource('openmaptiles')) {
      map.addLayer({
        id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-extrusion-color': '#d6d3d1',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 10],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.85,
        },
      });
    }
    set3d($('toggle3d').checked);
  }

  function set3d(on) {
    if (map.getLayer('building-3d')) map.setLayoutProperty('building-3d', 'visibility', on ? 'visible' : 'none');
    map.easeTo({ pitch: on ? 55 : 0, bearing: on ? map.getBearing() : 0, duration: 800 });
  }

  function setSatellite(on) {
    const v = on ? 'visible' : 'none';
    ['satellite-base', 'satellite-roads', 'satellite-labels'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
    });
    if ($('toggleSatellite')) $('toggleSatellite').checked = on;
    const btn = $('map-satellite-btn');
    if (btn) {
      btn.classList.toggle('active', on);
      btn.title = on ? 'Kembali ke Peta Standar' : 'Beralih ke Citra Satelit';
    }
  }

  map.on('click', (e) => {
    if (nav.active) return;
    if (map.queryRenderedFeatures(e.point, { layers: ['routes-alt'] }).length) return;
    const key = !state.from ? 'from' : !state.to ? 'to' : 'to';
    setPoint(key, e.lngLat, null).then(() => state.from && state.to && findRoute());
  });

  async function setPoint(key, lngLat, label) {
    state[key] = { lng: lngLat.lng, lat: lngLat.lat };
    markers[key].setLngLat(lngLat).addTo(map);
    $(key).value = label || `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
    if (!label) {
      const name = await reverseGeocode(lngLat).catch(() => null);
      if (name) $(key).value = name;
    }
  }

  // ---------- Geocoding (Photon / OSM) ----------
  function formatPlace(p) {
    const main = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || 'Tanpa nama';
    const sub = [p.street && p.name ? p.street : null, p.district, p.city, p.state, p.country]
      .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    return { main, sub };
  }

  async function reverseGeocode({ lng, lat }) {
    const r = await fetch(`${PHOTON}/reverse?lat=${lat}&lon=${lng}&lang=default`);
    const j = await r.json();
    const p = j.features?.[0]?.properties;
    if (!p) return null;
    const { main, sub } = formatPlace(p);
    return sub ? `${main}, ${sub}` : main;
  }

  function setupAutocomplete(key) {
    const input = $(key);
    const list = $(`${key}-suggest`);
    let timer, controller;

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { list.replaceChildren(); return; }
      timer = setTimeout(async () => {
        controller?.abort();
        controller = new AbortController();
        const c = map.getCenter();
        try {
          const url = `${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6&lat=${c.lat}&lon=${c.lng}`;
          const j = await (await fetch(url, { signal: controller.signal })).json();
          renderSuggestions(key, j.features || []);
        } catch (err) {
          if (err.name !== 'AbortError') setStatus('Gagal mencari lokasi.', true);
        }
      }, 300);
    });
    input.addEventListener('blur', () => setTimeout(() => list.replaceChildren(), 200));
  }

  function renderSuggestions(key, features) {
    const list = $(`${key}-suggest`);
    list.replaceChildren(...features.map((f) => {
      const { main, sub } = formatPlace(f.properties);
      const li = document.createElement('li');
      const b = document.createElement('span');
      b.textContent = main;
      const s = document.createElement('small');
      s.textContent = sub;
      li.append(b, s);
      li.addEventListener('mousedown', async () => {
        const [lng, lat] = f.geometry.coordinates;
        list.replaceChildren();
        await setPoint(key, { lng, lat }, sub ? `${main}, ${sub}` : main);
        if (state.from && state.to) findRoute();
        else map.flyTo({ center: [lng, lat], zoom: 15 });
      });
      return li;
    }));
  }

  // ---------- Routing ----------
  async function findRoute({ reroute = false } = {}) {
    if (!state.from || !state.to) { setStatus('Isi asal dan tujuan dulu.', true); return; }
    const mode = $('mode').value;
    const optimize = $('optimize').value;

    $('go').disabled = true;
    setStatus('Menghitung rute + lalu lintas real-time…');
    try {
      let routes;
      let src = 'TomTom (macet real-time)';
      try {
        routes = await routeTomTom(mode, optimize, TOMTOM_KEY);
      } catch (ttErr) {
        routes = await routeOsrm(mode);
        src = 'OSRM / OpenStreetMap';
      }
      if (!routes || !routes.length) throw new Error('Rute tidak ditemukan.');

      const shortest = Math.min(...routes.map((r) => r.distance));
      const fastest = Math.min(...routes.map((r) => r.duration));
      routes.forEach((r) => { r.isShortest = r.distance === shortest; r.isFastest = r.duration === fastest; });
      routes.sort((a, b) => optimize === 'distance' ? a.distance - b.distance : a.duration - b.duration);

      state.routes = routes;
      selectRoute(0, !reroute);
      setStatus(`${routes.length} rute ditemukan · sumber: ${src}`);
    } catch (err) {
      setStatus(err.message || 'Gagal menghitung rute.', true);
      // While navigating keep the old route; the next off-route fixes retry after the cooldown.
      if (reroute) return;
      state.routes = [];
      renderRoutes();
      $('results').replaceChildren();
      updateReopenLabel();
    } finally {
      $('go').disabled = false;
    }
  }

  async function routeOsrm(mode) {
    const { from, to } = state;
    const url = `${OSRM[mode]}/${from.lng},${from.lat};${to.lng},${to.lat}` +
      '?alternatives=3&steps=true&overview=full&geometries=geojson';
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Server rute error (${r.status}).`);
    const j = await r.json();
    if (j.code !== 'Ok') throw new Error(j.message || 'Rute tidak ditemukan.');
    return j.routes.map((rt) => ({
      distance: rt.distance,
      duration: rt.duration,
      delay: null,
      coords: rt.geometry.coordinates,
      traffic: [],
      steps: rt.legs.flatMap((l) => l.steps).map((s, _, all) => ({
        offset: all.slice(0, all.indexOf(s)).reduce((sum, p) => sum + p.distance, 0),
        icon: maneuverIcon(s.maneuver.type === 'arrive' || s.maneuver.type.includes('round') || s.maneuver.type === 'rotary'
          ? s.maneuver.type : s.maneuver.modifier),
        text: osrmInstruction(s),
        distance: s.distance,
      })),
    }));
  }

  async function routeTomTom(mode, optimize, key) {
    const { from, to } = state;
    const params = new URLSearchParams({
      key,
      traffic: 'true',
      maxAlternatives: '3',
      routeType: optimize === 'distance' ? 'shortest' : 'fastest',
      travelMode: TT_MODE[mode],
      sectionType: 'traffic',
      instructionsType: 'text',
      language: 'id-ID',
      computeTravelTimeFor: 'all',
    });
    const url = `https://api.tomtom.com/routing/1/calculateRoute/${from.lat},${from.lng}:${to.lat},${to.lng}/json?${params}`;
    const r = await fetch(url);
    if (r.status === 403 || r.status === 401) throw new Error('TomTom API key tidak valid.');
    if (!r.ok) throw new Error(`TomTom error (${r.status}).`);
    const j = await r.json();

    return (j.routes || []).map((rt) => {
      const coords = rt.legs.flatMap((l) => l.points.map((p) => [p.longitude, p.latitude]));
      const traffic = (rt.sections || [])
        .filter((s) => s.sectionType === 'TRAFFIC')
        .map((s) => ({
          coords: coords.slice(s.startPointIndex, s.endPointIndex + 1),
          color: TRAFFIC_COLORS[Math.min(s.magnitudeOfDelay ?? 1, 4)] || TRAFFIC_COLORS[2],
        }));
      return {
        distance: rt.summary.lengthInMeters,
        duration: rt.summary.travelTimeInSeconds,
        delay: rt.summary.trafficDelayInSeconds ?? 0,
        coords,
        traffic,
        steps: (rt.guidance?.instructions || []).map((ins, i, arr) => ({
          offset: ins.routeOffsetInMeters,
          icon: maneuverIcon(ins.maneuver),
          text: ins.message || ins.street || 'Lanjutkan',
          distance: (arr[i + 1]?.routeOffsetInMeters ?? rt.summary.lengthInMeters) - ins.routeOffsetInMeters,
        })),
      };
    });
  }

  const MOD_ID = {
    left: 'kiri', right: 'kanan', 'slight left': 'serong kiri', 'slight right': 'serong kanan',
    'sharp left': 'tajam ke kiri', 'sharp right': 'tajam ke kanan', straight: 'lurus', uturn: 'putar balik',
  };
  function osrmInstruction(s) {
    const { type, modifier, exit } = s.maneuver;
    const road = s.name ? ` ke ${s.name}` : '';
    const dir = MOD_ID[modifier] || '';
    switch (type) {
      case 'depart': return `Berangkat${s.name ? ` via ${s.name}` : ''}`;
      case 'arrive': return 'Sampai di tujuan';
      case 'roundabout':
      case 'rotary': return `Masuk bundaran, ambil keluar ke-${exit || 1}${road}`;
      case 'merge': return `Bergabung${road}`;
      case 'on ramp': return `Masuk jalur${road}`;
      case 'off ramp': return `Keluar jalur${road}`;
      case 'fork': return `Ambil ${dir || 'cabang'}${road}`;
      case 'continue':
      case 'new name': return `Lanjut ${dir || 'lurus'}${road}`;
      default:
        if (modifier === 'uturn') return `Putar balik${road}`;
        if (modifier === 'straight') return `Lurus${road}`;
        return `Belok ${dir}${road}`.trim();
    }
  }

  function selectRoute(idx, fit = false) {
    state.active = idx;
    renderRoutes();
    renderResults();
    updateReopenLabel();
    if (fit) {
      const b = new maplibregl.LngLatBounds();
      state.routes[idx].coords.forEach((c) => b.extend(c));
      const isCollapsed = $('panel')?.classList.contains('collapsed');
      const left = window.innerWidth > 768 ? (isCollapsed ? 40 : 400) : 40;
      const bottom = window.innerWidth > 768 ? 60 : (isCollapsed ? 70 : window.innerHeight * 0.55);
      map.fitBounds(b, { padding: { top: 60, right: 60, bottom, left }, pitch: $('toggle3d').checked ? 50 : 0, duration: 1000 });
    }
  }

  function renderRoutes() {
    if (!map.getSource('routes')) return;
    // Draw alternatives first so the active route sits on top.
    const features = state.routes
      .map((r, i) => ({
        type: 'Feature',
        properties: { idx: i, active: i === state.active },
        geometry: { type: 'LineString', coordinates: r.coords },
      }))
      .sort((a, b) => Number(a.properties.active) - Number(b.properties.active));
    map.getSource('routes').setData({ type: 'FeatureCollection', features });

    const active = state.routes[state.active];
    map.getSource('traffic').setData({
      type: 'FeatureCollection',
      features: (active?.traffic || []).filter((t) => t.coords.length > 1).map((t) => ({
        type: 'Feature', properties: { color: t.color },
        geometry: { type: 'LineString', coordinates: t.coords },
      })),
    });
  }

  function renderResults() {
    const box = $('results');
    box.replaceChildren(...state.routes.map((r, i) => {
      const card = document.createElement('div');
      card.className = 'card' + (i === state.active ? ' active' : '');
      card.addEventListener('click', () => selectRoute(i, true));

      const top = document.createElement('div');
      top.className = 'card-top';
      const dist = document.createElement('span');
      dist.className = 'dist';
      dist.textContent = fmtDist(r.distance);
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = fmtDur(r.duration);
      top.append(dist, dur);

      const badges = document.createElement('div');
      badges.className = 'badges';
      if (r.isShortest) badges.append(badge('Terpendek', 'green'));
      if (r.isFastest) badges.append(badge('Tercepat', 'blue'));
      if (r.delay > 60) badges.append(badge(`Macet +${fmtDur(r.delay)}`, 'red'));
      else if (r.delay !== null) badges.append(badge('Lancar', 'green'));

      card.append(top, badges);

      if (i === state.active && r.steps.length) {
        const det = document.createElement('details');
        det.className = 'steps';
        const sum = document.createElement('summary');
        sum.textContent = `Petunjuk arah (${r.steps.length} langkah)`;
        const ol = document.createElement('ol');
        r.steps.forEach((s) => {
          const li = document.createElement('li');
          li.textContent = s.text;
          if (s.distance > 0) {
            const sm = document.createElement('small');
            sm.textContent = fmtDist(s.distance);
            li.append(sm);
          }
          ol.append(li);
        });
        det.append(sum, ol);
        det.addEventListener('click', (e) => e.stopPropagation());
        card.append(det);
      }
      if (i === state.active) {
        const start = document.createElement('button');
        start.className = 'primary start-nav';
        start.textContent = 'Mulai Perjalanan';
        start.addEventListener('click', (e) => { e.stopPropagation(); startNav(); });
        card.append(start);
      }
      return card;
    }));
  }

  // ---------- Traffic flow tiles (TomTom) ----------
  function setTrafficLayer(on) {
    if (map.getLayer('traffic-flow')) map.removeLayer('traffic-flow');
    if (map.getSource('traffic-flow')) map.removeSource('traffic-flow');
    if (!on) return;
    map.addSource('traffic-flow', {
      type: 'raster', tileSize: 256,
      tiles: [`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${encodeURIComponent(TOMTOM_KEY)}`],
    });
    map.addLayer({ id: 'traffic-flow', type: 'raster', source: 'traffic-flow', paint: { 'raster-opacity': 0.85 } }, 'routes-alt');
  }

  // ---------- Navigation ----------
  const nav = {
    active: false, watchId: null, simTimer: null, wakeLock: null,
    follow: true, voice: true, rerouting: false,
    offCount: 0, lastReroute: 0, lastBearing: 0,
    announcedFar: -1, announcedNear: -1, cum: [], total: 1,
  };
  const userEl = document.createElement('div');
  userEl.className = 'user-arrow';
  const userMarker = new maplibregl.Marker({ element: userEl, rotationAlignment: 'map', pitchAlignment: 'map' });

  function prepareNavRoute() {
    const { coords } = state.routes[state.active];
    nav.cum = [0];
    for (let i = 1; i < coords.length; i++) nav.cum.push(nav.cum[i - 1] + haversine(coords[i - 1], coords[i]));
    nav.total = nav.cum[nav.cum.length - 1] || 1;
    nav.announcedFar = nav.announcedNear = -1;
    nav.offCount = 0;
  }

  function startNav() {
    if (!state.routes.length) return;
    Object.assign(nav, { active: true, follow: true });
    document.body.classList.add('navigating');
    $('nav-recenter').classList.add('hidden');
    $('nav-stop').textContent = 'Akhiri';
    if (map.getLayer('routes-alt')) map.setLayoutProperty('routes-alt', 'visibility', 'none');
    prepareNavRoute();
    navigator.wakeLock?.request('screen').then((l) => (nav.wakeLock = l)).catch(() => {});
    speak('Memulai perjalanan');
    if ($('simulate').checked) startSim(); else startGps();
  }

  function startGps() {
    if (!navigator.geolocation) { $('nav-instr').textContent = 'Browser tidak mendukung GPS'; return; }
    $('nav-instr').textContent = 'Mencari sinyal GPS…';
    nav.watchId = navigator.geolocation.watchPosition(
      (p) => onPosition({ lng: p.coords.longitude, lat: p.coords.latitude }, p.coords.heading),
      (err) => { $('nav-instr').textContent = err.code === 1 ? 'Izin lokasi ditolak' : 'Mencari sinyal GPS…'; },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
  }

  // Test mode: drive along the active route at ~40 km/h so navigation can be tried on desktop.
  function startSim() {
    let along = 0;
    nav.simTimer = setInterval(() => {
      along = Math.min(along + 11, nav.total);
      const [lng, lat] = pointAt(along);
      onPosition({ lng, lat }, null);
    }, 1000);
  }

  function stopTracking() {
    if (nav.watchId !== null) navigator.geolocation.clearWatch(nav.watchId);
    clearInterval(nav.simTimer);
    nav.watchId = null;
    nav.simTimer = null;
    nav.wakeLock?.release().catch(() => {});
    nav.wakeLock = null;
  }

  function stopNav() {
    stopTracking();
    nav.active = false;
    window.speechSynthesis?.cancel();
    userMarker.remove();
    document.body.classList.remove('navigating');
    if (map.getLayer('routes-alt')) map.setLayoutProperty('routes-alt', 'visibility', 'visible');
    if (state.routes.length) selectRoute(state.active, true);
  }

  function onPosition(pos, heading) {
    if (!nav.active) return;
    const route = state.routes[state.active];
    const snap = snapToRoute(pos, route.coords);
    const onRoute = snap.dist <= 40;
    const bearing = onRoute ? snap.bearing : (heading ?? nav.lastBearing);
    const shown = onRoute ? snap.point : [pos.lng, pos.lat];
    nav.lastBearing = bearing;

    userMarker.setLngLat(shown).setRotation(bearing).addTo(map);
    if (nav.follow) {
      map.easeTo({
        center: shown, bearing, zoom: 17, pitch: 60, duration: 1000, easing: (t) => t,
        padding: { top: window.innerHeight * 0.35, bottom: 0, left: 0, right: 0 },
      });
    }

    if (nav.rerouting) return;
    if (!onRoute) {
      if (++nav.offCount >= 3 && Date.now() - nav.lastReroute > 10000) reroute(pos);
      return;
    }
    nav.offCount = 0;

    // Step offsets come from the routing API; scale our haversine progress to the same unit.
    const frac = Math.min(snap.along / nav.total, 1);
    const alongApi = frac * route.distance;
    const remaining = route.distance - alongApi;

    if (remaining < 25 || haversine([pos.lng, pos.lat], [state.to.lng, state.to.lat]) < 25) {
      arrive();
      return;
    }

    const idx = route.steps.findIndex((s) => s.offset > alongApi + 5);
    const step = route.steps[idx];
    if (step) {
      const toStep = step.offset - alongApi;
      $('nav-icon').textContent = step.icon || '↑';
      $('nav-dist').textContent = fmtDist(toStep);
      $('nav-instr').textContent = step.text;
      if (toStep <= 200 && toStep > 50 && nav.announcedFar !== idx) {
        nav.announcedFar = idx;
        speak(`Dalam ${fmtDistSpoken(toStep)}, ${step.text}`);
      } else if (toStep <= 50 && nav.announcedNear !== idx) {
        nav.announcedNear = idx;
        speak(step.text);
      }
    }

    const remainSec = route.duration * (1 - frac);
    const eta = new Date(Date.now() + remainSec * 1000);
    $('nav-eta').textContent = `${fmtDur(remainSec)} · tiba ${eta.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
    $('nav-remain').textContent = `${fmtDist(remaining)} lagi`;
  }

  async function reroute(pos) {
    nav.rerouting = true;
    nav.lastReroute = Date.now();
    $('nav-instr').textContent = 'Keluar rute, menghitung ulang…';
    speak('Menghitung ulang rute');
    state.from = { lng: pos.lng, lat: pos.lat };
    markers.from.setLngLat(pos);
    await findRoute({ reroute: true });
    prepareNavRoute();
    nav.rerouting = false;
  }

  function arrive() {
    stopTracking();
    $('nav-icon').textContent = '🏁';
    $('nav-dist').textContent = '';
    $('nav-instr').textContent = 'Sampai di tujuan';
    $('nav-remain').textContent = '';
    $('nav-eta').textContent = 'Perjalanan selesai';
    $('nav-stop').textContent = 'Selesai';
    speak('Anda telah sampai di tujuan');
  }

  function speak(text) {
    if (!nav.voice || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'id-ID';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  function snapToRoute(p, coords) {
    if (coords.length < 2) {
      return { dist: haversine([p.lng, p.lat], coords[0]), point: coords[0], along: 0, bearing: nav.lastBearing };
    }
    // Local equirectangular projection (meters) — accurate enough at city scale.
    const kx = Math.cos((p.lat * Math.PI) / 180) * 111320;
    const ky = 110540;
    let best = { dist: Infinity, i: 0, t: 0 };
    for (let i = 0; i < coords.length - 1; i++) {
      const ax = (coords[i][0] - p.lng) * kx, ay = (coords[i][1] - p.lat) * ky;
      const dx = (coords[i + 1][0] - coords[i][0]) * kx, dy = (coords[i + 1][1] - coords[i][1]) * ky;
      const len2 = dx * dx + dy * dy;
      if (!len2) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best.dist) best = { dist: d, i, t };
    }
    const a = coords[best.i], b = coords[best.i + 1];
    return {
      dist: best.dist,
      point: [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t],
      along: nav.cum[best.i] + (nav.cum[best.i + 1] - nav.cum[best.i]) * best.t,
      bearing: bearingOf(a, b),
    };
  }

  function pointAt(along) {
    const { coords } = state.routes[state.active];
    const i = Math.max(0, nav.cum.findIndex((c) => c >= along) - 1);
    const seg = (nav.cum[i + 1] ?? nav.cum[i]) - nav.cum[i];
    const t = seg ? (along - nav.cum[i]) / seg : 0;
    const a = coords[i], b = coords[i + 1] || a;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function bearingOf(a, b) {
    const rad = Math.PI / 180;
    const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
    const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad) - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }

  function maneuverIcon(kind) {
    const k = (kind || '').toLowerCase();
    if (k.includes('arrive')) return '🏁';
    if (k.includes('roundabout') || k.includes('rotary')) return '⟳';
    if (k.includes('uturn') || k.includes('u_turn')) return '↶';
    if (k.includes('slight') || k.includes('keep') || k.includes('bear')) return k.includes('left') ? '↖' : k.includes('right') ? '↗' : '↑';
    if (k.includes('left')) return '↰';
    if (k.includes('right')) return '↱';
    return '↑';
  }

  // ---------- Helpers ----------
  function badge(text, color) {
    const b = document.createElement('span');
    b.className = `badge ${color}`;
    b.textContent = text;
    return b;
  }
  function fmtDist(m) { return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; }
  function fmtDistSpoken(m) {
    return m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ' koma ')} kilometer` : `${Math.round(m / 10) * 10} meter`;
  }
  function fmtDur(s) {
    const min = Math.round(s / 60);
    if (min < 60) return `${min} mnt`;
    return `${Math.floor(min / 60)} j ${min % 60} mnt`;
  }
  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
  function setStatus(msg, isError = false) {
    $('status').textContent = msg;
    $('status').className = isError ? 'error' : '';
  }

  // ---------- Panel Hide / Show ----------
  function setPanelCollapsed(collapsed) {
    const panel = $('panel');
    const reopen = $('panel-reopen');
    if (!panel || !reopen) return;
    if (collapsed) {
      panel.classList.add('collapsed');
      reopen.classList.remove('hidden');
    } else {
      panel.classList.remove('collapsed');
      reopen.classList.add('hidden');
    }
    updateReopenLabel();
  }

  function updateReopenLabel() {
    const label = $('reopen-label');
    if (!label) return;
    const activeRoute = state.routes[state.active];
    if (activeRoute) {
      label.textContent = `Rute: ${fmtDist(activeRoute.distance)} (${fmtDur(activeRoute.duration)})`;
    } else {
      label.textContent = 'Buka Menu / Rute';
    }
  }

  // ---------- UI wiring ----------
  setupAutocomplete('from');
  setupAutocomplete('to');

  $('panel-toggle')?.addEventListener('click', () => setPanelCollapsed(true));
  $('panel-reopen')?.addEventListener('click', () => setPanelCollapsed(false));
  $('panel-handle')?.addEventListener('click', () => setPanelCollapsed(true));

  let touchStartY = 0;
  const panelHandle = $('panel-handle');
  if (panelHandle) {
    panelHandle.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    panelHandle.addEventListener('touchend', (e) => {
      if (e.changedTouches[0].clientY - touchStartY > 30) {
        setPanelCollapsed(true);
      }
    });
  }

  const panelHeader = $('panel-header');
  if (panelHeader) {
    panelHeader.addEventListener('touchstart', (e) => {
      if (e.target.closest('#panel-toggle')) return;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    panelHeader.addEventListener('touchend', (e) => {
      if (e.target.closest('#panel-toggle')) return;
      if (e.changedTouches[0].clientY - touchStartY > 40) {
        setPanelCollapsed(true);
      }
    });
  }

  $('go').addEventListener('click', () => findRoute());
  $('nav-stop').addEventListener('click', stopNav);
  $('nav-voice').addEventListener('click', () => {
    nav.voice = !nav.voice;
    $('nav-voice').textContent = nav.voice ? '🔊' : '🔇';
    if (!nav.voice) window.speechSynthesis?.cancel();
  });
  $('nav-recenter').addEventListener('click', () => {
    nav.follow = true;
    $('nav-recenter').classList.add('hidden');
  });
  map.on('dragstart', () => {
    if (!nav.active) return;
    nav.follow = false;
    $('nav-recenter').classList.remove('hidden');
  });
  $('mode').addEventListener('change', () => state.from && state.to && findRoute());
  $('optimize').addEventListener('change', () => state.from && state.to && findRoute());
  $('toggle3d').addEventListener('change', (e) => set3d(e.target.checked));
  $('toggleTraffic').addEventListener('change', (e) => setTrafficLayer(e.target.checked));
  $('toggleSatellite')?.addEventListener('change', (e) => setSatellite(e.target.checked));
  $('map-satellite-btn')?.addEventListener('click', () => {
    const isNow = !$('map-satellite-btn').classList.contains('active');
    setSatellite(isNow);
  });

  $('swap').addEventListener('click', () => {
    [state.from, state.to] = [state.to, state.from];
    [$('from').value, $('to').value] = [$('to').value, $('from').value];
    ['from', 'to'].forEach((k) => state[k] ? markers[k].setLngLat(state[k]).addTo(map) : markers[k].remove());
    if (state.from && state.to) findRoute();
  });

  $('myloc').addEventListener('click', () => {
    if (!navigator.geolocation) { setStatus('Browser tidak mendukung lokasi.', true); return; }
    setStatus('Mengambil lokasi…');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const ll = { lng: pos.coords.longitude, lat: pos.coords.latitude };
        await setPoint('from', ll, null);
        setStatus('');
        if (state.to) findRoute(); else map.flyTo({ center: ll, zoom: 15 });
      },
      () => setStatus('Izin lokasi ditolak.', true),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });

  // Register PWA service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
