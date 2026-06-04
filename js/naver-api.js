/**
 * Naver Map place 페이지를 CORS 프록시로 받아와 HTML에서 좌표·이름·주소를 파싱.
 * - 공식 API가 아닌 HTML 스크래핑이라 네이버 페이지 구조 변경 시 파싱이 깨질 수 있음.
 * - corsproxy.io 공개 프록시 사용. 자체 프록시로 교체하려면 js/config.js 의 corsProxy 변경.
 */
(function () {
  function proxy(url) {
    const base = (window.AppConfig && window.AppConfig.corsProxy) || 'https://corsproxy.io/?url=';
    return base + encodeURIComponent(url);
  }

  async function tryFetch(url) {
    try {
      const res = await fetch(proxy(url), { method: 'GET' });
      if (!res.ok) return null;
      const text = await res.text();
      if (!text || text.length < 500) return null;
      return text;
    } catch (e) {
      return null;
    }
  }

  /** Place ID로 m.place.naver.com 의 HTML을 받아옴. 두 가지 URL 패턴 시도. */
  async function fetchPlaceHtml(placeId) {
    const candidates = [
      `https://m.place.naver.com/restaurant/${placeId}/home`,
      `https://m.place.naver.com/place/${placeId}/home`,
      `https://m.place.naver.com/hairshop/${placeId}/home`,
      `https://m.place.naver.com/accommodation/${placeId}/home`,
    ];
    for (const u of candidates) {
      const html = await tryFetch(u);
      if (html && html.includes('"x"') || (html && html.includes('geo'))) return html;
      if (html) return html; // 첫 응답이라도 시도
    }
    return null;
  }

  /** 깊이 우선으로 객체 안에서 x/y 또는 latitude/longitude 조합을 탐색. */
  function findCoords(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 10) return null;
    if (obj.x != null && obj.y != null) {
      const x = parseFloat(obj.x), y = parseFloat(obj.y);
      if (!Number.isNaN(x) && !Number.isNaN(y) && x > 120 && x < 135 && y > 32 && y < 40) {
        return { lng: x, lat: y, name: obj.name || null,
                 address: obj.roadAddress || obj.address || null,
                 phone: obj.phone || null, category: obj.category || null };
      }
    }
    if (obj.latitude != null && obj.longitude != null) {
      const la = parseFloat(obj.latitude), lo = parseFloat(obj.longitude);
      if (!Number.isNaN(la) && !Number.isNaN(lo)) {
        return { lat: la, lng: lo, name: obj.name || null };
      }
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'object') {
        const found = findCoords(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function parsePlaceHtml(html) {
    const out = { name: null, address: null, lat: null, lng: null, phone: null, category: null };

    // 1) JSON-LD
    const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = ldRe.exec(html)) !== null) {
      try {
        const data = JSON.parse(m[1]);
        const arr = Array.isArray(data) ? data : [data];
        for (const obj of arr) {
          if (obj && obj.name && !out.name) out.name = obj.name;
          if (obj && obj.address) {
            const a = typeof obj.address === 'string' ? obj.address : (obj.address.streetAddress || obj.address.addressLocality);
            if (a) out.address = out.address || a;
          }
          if (obj && obj.geo && out.lat == null) {
            const la = parseFloat(obj.geo.latitude), lo = parseFloat(obj.geo.longitude);
            if (!Number.isNaN(la) && !Number.isNaN(lo)) { out.lat = la; out.lng = lo; }
          }
          if (obj && obj.telephone && !out.phone) out.phone = obj.telephone;
        }
      } catch (e) { /* ignore */ }
    }

    // 2) Apollo state (window.__APOLLO_STATE__ = {...};)
    if (out.lat == null) {
      const apolloMatch = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
      if (apolloMatch) {
        try {
          const apollo = JSON.parse(apolloMatch[1]);
          const found = findCoords(apollo, 0);
          if (found) {
            out.lat = found.lat;
            out.lng = found.lng;
            if (found.name) out.name = out.name || found.name;
            if (found.address) out.address = out.address || found.address;
            if (found.phone) out.phone = out.phone || found.phone;
            if (found.category) out.category = out.category || found.category;
          }
        } catch (e) { /* ignore */ }
      }
    }

    // 3) Inline pattern: "y":"37.xxx","x":"127.xxx"
    if (out.lat == null) {
      const yx = html.match(/"y"\s*:\s*"?([\d.]+)"?\s*,\s*"x"\s*:\s*"?([\d.]+)"?/);
      const xy = html.match(/"x"\s*:\s*"?([\d.]+)"?\s*,\s*"y"\s*:\s*"?([\d.]+)"?/);
      const pick = yx || xy;
      if (pick) {
        const aa = parseFloat(yx ? pick[1] : pick[2]);
        const bb = parseFloat(yx ? pick[2] : pick[1]);
        if (aa > 33 && aa < 39 && bb > 124 && bb < 132) {
          out.lat = aa; out.lng = bb;
        }
      }
    }

    // 4) og:title 에서 이름
    if (!out.name) {
      const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/);
      if (og) out.name = og[1].replace(/\s*:\s*네이버.*$/, '').trim();
    }

    // 5) og:description 등에서 주소 후보 (선택적)
    if (!out.address) {
      const desc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/);
      if (desc && /\d/.test(desc[1])) {
        // 그냥 사용하지 않고 fallback 으로만
      }
    }

    return out;
  }

  const NaverApi = {
    /** placeId 만으로 모든 정보 조회. 실패 시 null. */
    async getPlaceById(placeId) {
      if (!placeId) return null;
      const html = await fetchPlaceHtml(placeId);
      if (!html) return null;
      const info = parsePlaceHtml(html);
      if (!info.name && info.lat == null) return null;
      return info;
    },
  };

  window.NaverApi = NaverApi;
})();
