/**
 * Naver Maps integration.
 * - 지도 초기화
 * - 주소 → 좌표 (Geocoder submodule)
 * - 마커 표시
 * - Naver Map URL 파싱: 이름, placeId, 좌표 추출 (best-effort)
 * - 지도 클릭으로 좌표 직접 지정 모드
 * - 회사 ↔ 룰렛 당첨 가게 도보 동선 (직선 + 예상 도보 거리·시간)
 */
(function () {
  let map = null;
  let markers = [];
  let markerEntries = new Map(); // store.id → { marker, info }
  let fixedCompanyMarker = null;
  let fixedCompanyInfo = null;
  let pickModeListener = null;
  let pickModeCallback = null;
  let nextInfoWindowId = 1;
  let walkLine = null;
  let walkKey = '';
  let walkStore = null;
  // 도보 동선 추정: 실제 길은 직선보다 돌아가므로 우회 계수를 곱하고, 성인 평균 보행 속도로 시간 계산
  const WALK_DETOUR_FACTOR = 1.3;
  const WALK_METERS_PER_MINUTE = 75; // 4.5km/h
  const DEFAULT_ZOOM = 17; // 종로권 기준 약 50m 축척 (메인 지도는 이 축척으로 고정)
  const FIXED_LOCATION = {
    name: '연강빌딩',
    roadAddress: '서울 종로구 종로33길 15',
    jibunAddress: '서울 종로구 연지동 270',
    address: '서울 종로구 종로33길 15',
    lat: 37.5705075,
    lng: 126.9924185,
    resolved: false,
  };
  const DEFAULT_CENTER = { lat: FIXED_LOCATION.lat, lng: FIXED_LOCATION.lng };

  function ready() {
    return typeof naver !== 'undefined' && naver.maps;
  }

  const Maps = {
    init(containerId) {
      if (!ready()) {
        console.warn('Naver Maps API not loaded.');
        const el = document.getElementById(containerId);
        if (el) {
          el.innerHTML =
            '<div style="padding:20px;color:#888;text-align:center">' +
            '네이버 지도 API를 불러오지 못했습니다. Client ID를 확인하거나, ' +
            '<code>ncpKeyId</code> ↔ <code>ncpClientId</code> 파라미터를 바꿔보세요.' +
            '</div>';
        }
        return;
      }
      map = new naver.maps.Map(containerId, {
        center: new naver.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
        zoom: DEFAULT_ZOOM,
        // 확대/축소 막기: 50m 축척 고정 (이동은 가능)
        minZoom: DEFAULT_ZOOM,
        maxZoom: DEFAULT_ZOOM,
        zoomControl: false,
        scrollWheel: false,
        pinchZoom: false,
        disableDoubleClickZoom: true,
        disableDoubleTapZoom: true,
        disableTwoFingerTapZoom: true,
      });
      ensureFixedCompanyMarker();
      this.resolveFixedLocation({ recenter: true }).catch((e) => {
        console.warn('fixed location geocode failed:', e);
      });
    },

    async reload(containerId) {
      this.disablePickMode();
      this.clearWalkRoute();
      this.clearMarkers();
      if (fixedCompanyMarker) fixedCompanyMarker.setMap(null);
      fixedCompanyMarker = null;
      fixedCompanyInfo = null;
      map = null;
      const el = document.getElementById(containerId);
      if (el) el.innerHTML = '';
      await reloadNaverMapScript().catch((e) => {
        console.warn('Naver Maps API script reload failed:', e);
      });
      this.init(containerId);
    },

    /** 마커를 지우고, 말풍선이 열려 있던 가게 id 목록을 돌려줌 (다시 그릴 때 그대로 열어 두기 위함) */
    clearMarkers() {
      const openIds = new Set();
      markerEntries.forEach((entry, id) => {
        if (entry.info.getMap()) openIds.add(id);
        entry.info.close();
      });
      markers.forEach((m) => m.setMap(null));
      markers = [];
      markerEntries = new Map();
      return openIds;
    },

    openStoreInfo(storeId) {
      const entry = markerEntries.get(storeId);
      if (!entry || entry.info.getMap()) return;
      entry.info.open(map, entry.marker);
      bindInfoWindowCloseButton(entry.info);
    },

    renderStores(stores, options = {}) {
      if (!ready() || !map) return;
      const reopenIds = this.clearMarkers();
      const autoFit = options.autoFit === true;
      const bounds = autoFit ? new naver.maps.LatLngBounds() : null;
      let count = 0;
      stores.forEach((s) => {
        if (s.lat == null || s.lng == null) return;
        const position = new naver.maps.LatLng(s.lat, s.lng);
        // 기본은 점 + 가게 이름. 말풍선이 열려 있을 때는 이름이 겹치지 않도록 점만 표시
        const dotHtml =
          '<span style="width:10px;height:10px;border-radius:50%;background:#2f57e5;display:inline-block;' +
          'box-shadow:0 0 0 2px #fff,0 1px 2px rgba(0,0,0,.35)"></span>';
        const labeledIcon = {
          content:
            '<div style="display:flex;align-items:center;gap:5px;transform:translateY(-6px)">' + dotHtml +
            '<span style="background:rgba(255,255,255,.96);border:1px solid #d9dff8;border-radius:999px;' +
            'padding:2px 8px;font-size:12px;font-weight:600;color:#1f2330;white-space:nowrap">' +
            escapeHtml(s.name) +
            '</span></div>',
          anchor: new naver.maps.Point(12, 12),
        };
        const dotIcon = {
          content: '<div style="display:flex;align-items:center;transform:translateY(-6px)">' + dotHtml + '</div>',
          anchor: new naver.maps.Point(12, 12),
        };
        const marker = new naver.maps.Marker({
          position,
          map,
          title: s.name,
          icon: labeledIcon,
        });
        const cleanMemo = stripPlaceIdToken(s.memo);
        const infoId = makeInfoWindowId();
        const info = new naver.maps.InfoWindow({
          content: buildStoreInfoContent(s, cleanMemo, infoId),
          disableAnchor: false,
          disableAutoPan: true,
        });
        info.__closeButtonId = infoId;
        // 말풍선을 열고 닫을 때(마커 클릭 · × 버튼 · 다시 그리기 모두) 가게 이름 표시를 함께 전환
        const openInfo = info.open.bind(info);
        const closeInfo = info.close.bind(info);
        info.open = (...args) => { marker.setIcon(dotIcon); return openInfo(...args); };
        info.close = (...args) => { marker.setIcon(labeledIcon); return closeInfo(...args); };
        // 클릭 시 토글 (이미 열려있으면 닫기)
        naver.maps.Event.addListener(marker, 'click', () => {
          if (info.getMap()) info.close();
          else {
            info.open(map, marker);
            bindInfoWindowCloseButton(info);
          }
        });
        markers.push(marker);
        markerEntries.set(s.id, { marker, info });
        if (reopenIds.has(s.id)) this.openStoreInfo(s.id);
        if (autoFit) {
          bounds.extend(position);
          count++;
        }
      });
      if (autoFit && bounds && count > 0) map.fitBounds(bounds);
    },

    focus(store) {
      if (!ready() || !map || store.lat == null || store.lng == null) return;
      const pos = new naver.maps.LatLng(store.lat, store.lng);
      map.setCenter(pos);
      map.setZoom(DEFAULT_ZOOM);
    },

    async moveToFixedLocation() {
      if (!ready() || !map) return null;
      await this.resolveFixedLocation();
      // 사용자가 지정한 고정 위치(연강빌딩)로만 이동
      const pos = new naver.maps.LatLng(FIXED_LOCATION.lat, FIXED_LOCATION.lng);
      map.setCenter(pos);
      map.setZoom(DEFAULT_ZOOM);
      ensureFixedCompanyMarker();
      if (fixedCompanyInfo && fixedCompanyMarker) {
        fixedCompanyInfo.open(map, fixedCompanyMarker);
        bindInfoWindowCloseButton(fixedCompanyInfo);
      }
      return {
        name: FIXED_LOCATION.name,
        address: FIXED_LOCATION.address,
        lat: FIXED_LOCATION.lat,
        lng: FIXED_LOCATION.lng,
      };
    },

    async resolveFixedLocation(options = {}) {
      if (!ready() || !map) return null;
      if (!FIXED_LOCATION.resolved) {
        const candidates = [FIXED_LOCATION.roadAddress, FIXED_LOCATION.jibunAddress, FIXED_LOCATION.address];
        for (const query of candidates) {
          const geo = await this.geocode(query);
          if (!geo || geo.lat == null || geo.lng == null) continue;
          FIXED_LOCATION.lat = geo.lat;
          FIXED_LOCATION.lng = geo.lng;
          FIXED_LOCATION.address = FIXED_LOCATION.roadAddress;
          FIXED_LOCATION.resolved = true;
          break;
        }
      }
      ensureFixedCompanyMarker();
      if (walkStore) {
        // 회사 좌표가 보정됐으면 동선도 새 좌표로 다시 그림
        const store = walkStore;
        walkKey = '';
        this.showWalkRoute(store);
      } else if (options.recenter === true) {
        map.setCenter(new naver.maps.LatLng(FIXED_LOCATION.lat, FIXED_LOCATION.lng));
      }
      return {
        name: FIXED_LOCATION.name,
        address: FIXED_LOCATION.address,
        lat: FIXED_LOCATION.lat,
        lng: FIXED_LOCATION.lng,
      };
    },

    geocode(address) {
      return new Promise((resolve) => {
        if (!ready() || !naver.maps.Service) { resolve(null); return; }
        naver.maps.Service.geocode({ query: address }, function (status, response) {
          if (status !== naver.maps.Service.Status.OK) { resolve(null); return; }
          const items = response.v2 && response.v2.addresses;
          if (!items || items.length === 0) { resolve(null); return; }
          const first = items[0];
          resolve({
            lat: parseFloat(first.y),
            lng: parseFloat(first.x),
            address: first.roadAddress || first.jibunAddress || null,
          });
        });
      });
    },

    /**
     * Naver Map URL 파싱 (best-effort)
     * 추출 시도:
     *   - name: searchText / bk_query / path의 search 다음 세그먼트
     *   - placeId: path의 place 다음 세그먼트
     *   - lat/lng: c= 파라미터에서 한국 좌표 범위 매칭
     * 단축 URL(naver.me/...)은 CORS 때문에 해석 불가.
     */
    parseUrl(url) {
      if (!url) return null;
      const result = { name: null, placeId: null, lat: null, lng: null, address: null, url };
      try {
        const u = new URL(url);

        // 1) Query 파라미터 기반
        const searchText = u.searchParams.get('searchText');
        const bkQuery = u.searchParams.get('bk_query');
        if (searchText) result.name = safeDecode(searchText);
        else if (bkQuery) result.name = safeDecode(bkQuery);

        // 2) 경로 기반: /p/search/{name}/place/{id} or /p/entry/place/{id}
        const pathParts = u.pathname.split('/').filter(Boolean);
        const searchIdx = pathParts.indexOf('search');
        if (searchIdx >= 0 && pathParts[searchIdx + 1] && !result.name) {
          result.name = safeDecode(pathParts[searchIdx + 1]);
        }
        const placeIdx = pathParts.indexOf('place');
        if (placeIdx >= 0 && pathParts[placeIdx + 1]) {
          result.placeId = pathParts[placeIdx + 1].split('?')[0];
        }

        // 3) c= 좌표
        const c = u.searchParams.get('c');
        if (c) {
          const parts = c.split(',').map(Number).filter((n) => !Number.isNaN(n));
          for (let i = 0; i < parts.length - 1; i++) {
            const a = parts[i], b = parts[i + 1];
            // Korean lng range 124~132, lat range 33~39
            if (a >= 124 && a <= 132 && b >= 33 && b <= 39) { result.lng = a; result.lat = b; break; }
            if (b >= 124 && b <= 132 && a >= 33 && a <= 39) { result.lat = a; result.lng = b; break; }
          }
        }

        // placePath 안의 추가 쿼리(bk_query 등)도 시도
        const placePath = u.searchParams.get('placePath');
        if (placePath && !result.name) {
          const fakeUrl = 'https://x' + (placePath.startsWith('/') ? placePath : '/' + placePath);
          try {
            const p = new URL(fakeUrl);
            const bk2 = p.searchParams.get('bk_query');
            if (bk2) result.name = safeDecode(bk2);
          } catch (e) { /* ignore */ }
        }

        return result;
      } catch (e) {
        return null;
      }
    },

    /**
     * 지도 클릭 모드 활성화. 다음 클릭 좌표가 callback(lat, lng)로 전달되고
     * 자동으로 모드 종료.
     */
    enablePickMode(callback) {
      if (!ready() || !map) return;
      this.disablePickMode();
      pickModeCallback = callback;
      const el = map.getElement && map.getElement();
      if (el) el.style.cursor = 'crosshair';
      pickModeListener = naver.maps.Event.addListener(map, 'click', (e) => {
        const cb = pickModeCallback;
        const lat = e.coord.lat();
        const lng = e.coord.lng();
        this.disablePickMode();
        if (cb) cb(lat, lng);
      });
    },

    disablePickMode() {
      if (pickModeListener) {
        naver.maps.Event.removeListener(pickModeListener);
        pickModeListener = null;
      }
      pickModeCallback = null;
      if (map) {
        const el = map.getElement && map.getElement();
        if (el) el.style.cursor = '';
      }
    },

    isPickMode() { return pickModeListener != null; },

    getCompanyLocation() {
      return { name: FIXED_LOCATION.name, lat: FIXED_LOCATION.lat, lng: FIXED_LOCATION.lng };
    },

    /** 회사 → 가게 직선거리와 예상 도보 거리·시간 */
    estimateWalk(store) {
      if (!store || store.lat == null || store.lng == null) return null;
      const straightM = distanceMeters(FIXED_LOCATION.lat, FIXED_LOCATION.lng, store.lat, store.lng);
      const walkM = straightM * WALK_DETOUR_FACTOR;
      return {
        straightM: Math.round(straightM),
        walkM: Math.round(walkM),
        minutes: Math.max(1, Math.ceil(walkM / WALK_METERS_PER_MINUTE)),
      };
    },

    /**
     * 회사와 가게를 점선으로 잇기 (예상 도보 시간은 지도 아래 문구로 표시).
     * 처음 그릴 때 지도 중심을 회사와 가게의 정가운데로 옮기고 가게 말풍선을 연다.
     * 같은 가게면 다시 그리지 않음 (사용자가 닫은 말풍선을 다시 열지 않도록).
     */
    showWalkRoute(store) {
      const estimate = this.estimateWalk(store);
      if (!ready() || !map || !estimate) {
        this.clearWalkRoute();
        return estimate;
      }
      const key = [store.id, store.lat, store.lng, FIXED_LOCATION.lat, FIXED_LOCATION.lng].join(':');
      if (key === walkKey && walkLine) return estimate;
      this.clearWalkRoute();
      walkKey = key;
      walkStore = store;

      const from = new naver.maps.LatLng(FIXED_LOCATION.lat, FIXED_LOCATION.lng);
      const to = new naver.maps.LatLng(store.lat, store.lng);
      walkLine = new naver.maps.Polyline({
        map,
        path: [from, to],
        strokeColor: '#e5484d',
        strokeWeight: 4,
        strokeOpacity: 0.9,
        strokeStyle: 'shortdash',
        strokeLineCap: 'round',
      });
      map.setCenter(new naver.maps.LatLng((store.lat + FIXED_LOCATION.lat) / 2, (store.lng + FIXED_LOCATION.lng) / 2));
      this.openStoreInfo(store.id);
      return estimate;
    },

    clearWalkRoute() {
      if (walkLine) walkLine.setMap(null);
      walkLine = null;
      walkKey = '';
      walkStore = null;
    },

    formatMeters,
  };

  function distanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function formatMeters(m) {
    return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch { return s; }
  }
  function ensureFixedCompanyMarker() {
    if (!ready() || !map) return;
    const position = new naver.maps.LatLng(FIXED_LOCATION.lat, FIXED_LOCATION.lng);
    if (!fixedCompanyMarker) {
      fixedCompanyMarker = new naver.maps.Marker({
        position,
        map,
        title: FIXED_LOCATION.name,
        icon: {
          content:
            '<div style="width:32px;height:32px;border-radius:50%;background:#1f4b99;color:#fff;' +
            'display:flex;align-items:center;justify-content:center;font-size:16px;' +
            'box-shadow:0 2px 6px rgba(0,0,0,.3);border:2px solid #fff;">🏢</div>',
          anchor: new naver.maps.Point(16, 16),
        },
      });
      const fixedInfoId = makeInfoWindowId();
      fixedCompanyInfo = new naver.maps.InfoWindow({
        content: buildFixedCompanyInfoContent(fixedInfoId),
        disableAutoPan: true,
      });
      fixedCompanyInfo.__closeButtonId = fixedInfoId;
      naver.maps.Event.addListener(fixedCompanyMarker, 'click', () => {
        if (!fixedCompanyInfo) return;
        if (fixedCompanyInfo.getMap()) fixedCompanyInfo.close();
        else {
          fixedCompanyInfo.open(map, fixedCompanyMarker);
          bindInfoWindowCloseButton(fixedCompanyInfo);
        }
      });
      return;
    }
    fixedCompanyMarker.setPosition(position);
    fixedCompanyMarker.setMap(map);
    if (fixedCompanyInfo) {
      if (!fixedCompanyInfo.__closeButtonId) fixedCompanyInfo.__closeButtonId = makeInfoWindowId();
      fixedCompanyInfo.setContent(buildFixedCompanyInfoContent(fixedCompanyInfo.__closeButtonId));
    }
  }

  function makeInfoWindowId() {
    return `map-info-${nextInfoWindowId++}`;
  }

  function buildStoreInfoContent(store, cleanMemo, infoId) {
    return `
      <div class="map-info-window" data-map-info-id="${escapeHtml(infoId)}">
        <button type="button" class="map-info-close" data-map-info-close="${escapeHtml(infoId)}" aria-label="상세 정보 닫기">×</button>
        <div class="map-info-body">
          <strong class="map-info-title">${escapeHtml(store.name)}</strong><br/>
          ${store.address ? '<span class="map-info-address">' + escapeHtml(store.address) + '</span><br/>' : ''}
          ${store.category ? '<span class="map-info-muted">' + escapeHtml(store.category) + '</span><br/>' : ''}
          ${store.phone ? '<span>' + escapeHtml(store.phone) + '</span><br/>' : ''}
          ${cleanMemo ? '<span class="map-info-memo">📝 ' + escapeHtml(cleanMemo) + '</span><br/>' : ''}
          ${store.url ? '<a href="' + encodeURI(store.url) + '" target="_blank" rel="noopener">네이버 지도에서 보기</a>' : ''}
        </div>
      </div>`;
  }

  function buildFixedCompanyInfoContent(infoId) {
    return `
      <div class="map-info-window" data-map-info-id="${escapeHtml(infoId)}">
        <button type="button" class="map-info-close" data-map-info-close="${escapeHtml(infoId)}" aria-label="상세 정보 닫기">×</button>
        <div class="map-info-body">
          <strong class="map-info-title">🏢 ${escapeHtml(FIXED_LOCATION.name)}</strong><br/>
          <span class="map-info-address">도로명: ${escapeHtml(FIXED_LOCATION.roadAddress)}</span><br/>
          <span class="map-info-muted">지번: ${escapeHtml(FIXED_LOCATION.jibunAddress)}</span>
        </div>
      </div>`;
  }

  function bindInfoWindowCloseButton(info) {
    setTimeout(() => {
      const id = info && info.__closeButtonId;
      if (!id) return;
      const closeBtn = document.querySelector(`.map-info-close[data-map-info-close="${cssEscape(id)}"]`);
      if (!closeBtn || closeBtn.dataset.bound === 'true') return;
      closeBtn.dataset.bound = 'true';
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        info.close();
      });
    }, 0);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function reloadNaverMapScript() {
    const existing = Array.from(document.scripts)
      .find((script) => String(script.src || '').includes('oapi.map.naver.com/openapi/v3/maps.js'));
    if (!existing) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const next = document.createElement('script');
      const src = new URL(existing.src);
      src.searchParams.set('_mapReload', String(Date.now()));
      next.type = existing.type || 'text/javascript';
      next.src = src.toString();
      next.onload = () => resolve(true);
      next.onerror = () => reject(new Error('Naver Maps script reload failed'));
      existing.parentNode.insertBefore(next, existing.nextSibling);
      existing.remove();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
  /** 옛 데이터 호환: memo 안의 placeId 토큰 제거. */
  function stripPlaceIdToken(memo) {
    if (!memo) return '';
    return String(memo)
      .replace(/\s*·\s*placeId:\S+/gi, '')
      .replace(/^placeId:\S+\s*·?\s*/i, '')
      .trim();
  }

  window.Maps = Maps;
})();
