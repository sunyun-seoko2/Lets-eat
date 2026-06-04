/**
 * Stores module — CRUD for restaurants per meal type.
 */
(function () {
  function uid() {
    return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function ensureMealCache(cache, meal) {
    if (!cache[meal]) cache[meal] = [];
  }

  function normalizeUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
      const u = new URL(raw);
      u.hash = '';
      u.protocol = u.protocol.toLowerCase();
      u.hostname = u.hostname.toLowerCase();
      if (u.pathname !== '/') u.pathname = u.pathname.replace(/\/+$/, '');
      return u.toString();
    } catch {
      return raw;
    }
  }

  function normalizeVisibleMeals(defaultMeal, inputVisibleMeals, legacyFridayFlag) {
    const allowedMeals = new Set(['lunch', 'dinner', 'fridayLunch']);
    const fromInput = Array.isArray(inputVisibleMeals) ? inputVisibleMeals : [];
    const visible = fromInput.filter((m) => allowedMeals.has(m));
    if (visible.length > 0) return Array.from(new Set(visible));
    const out = [defaultMeal];
    if (legacyFridayFlag) out.push('fridayLunch');
    return Array.from(new Set(out));
  }

  const Stores = {
    cache: {},

    async load(meal) {
      ensureMealCache(this.cache, meal);
      this.cache[meal] = await window.Storage.getStores(meal);
      return this.cache[meal];
    },

    async add(meal, partial) {
      ensureMealCache(this.cache, meal);
      const normalizedUrl = normalizeUrl(partial.url);
      if (normalizedUrl) {
        const duplicated = this.cache[meal].some((s) => normalizeUrl(s.url) === normalizedUrl);
        if (duplicated) {
          throw new Error('이미 등록된 네이버 지도 URL입니다. 중복 등록은 불가합니다.');
        }
      }
      const store = {
        id: uid(),
        name: partial.name.trim(),
        url: (partial.url || '').trim(),
        address: (partial.address || '').trim(),
        lat: partial.lat != null && partial.lat !== '' ? Number(partial.lat) : null,
        lng: partial.lng != null && partial.lng !== '' ? Number(partial.lng) : null,
        memo: (partial.memo || '').trim(),
        placeId: partial.placeId ? String(partial.placeId).trim() : null,
        phone: partial.phone ? String(partial.phone).trim() : null,
        category: partial.category ? String(partial.category).trim() : null,
        showInFridayLunchTab: Boolean(partial.showInFridayLunchTab || partial.showInCompanionLunchTab),
        avoidFor: normalizeNameList(partial.avoidFor),
        visibleMeals: normalizeVisibleMeals(
          meal,
          partial.visibleMeals,
          Boolean(partial.showInFridayLunchTab || partial.showInCompanionLunchTab)
        ),
        createdAt: Date.now(),
      };
      this.cache[meal].push(store);
      await window.Storage.saveStores(meal, this.cache[meal]);
      return store;
    },

    async remove(meal, id) {
      ensureMealCache(this.cache, meal);
      this.cache[meal] = this.cache[meal].filter((s) => s.id !== id);
      await window.Storage.saveStores(meal, this.cache[meal]);
    },

    async update(meal, id, patch) {
      ensureMealCache(this.cache, meal);
      const idx = this.cache[meal].findIndex((s) => s.id === id);
      if (idx < 0) return null;
      const current = this.cache[meal][idx];
      const next = { ...current, ...patch };
      if ('memo' in patch) next.memo = String(patch.memo || '').trim();
      if ('avoidFor' in patch) next.avoidFor = normalizeNameList(patch.avoidFor);
      if ('visibleMeals' in patch || 'showInFridayLunchTab' in patch || 'showInCompanionLunchTab' in patch) {
        next.visibleMeals = normalizeVisibleMeals(
          meal,
          patch.visibleMeals ?? current.visibleMeals,
          Boolean(patch.showInFridayLunchTab || patch.showInCompanionLunchTab)
        );
      }
      this.cache[meal][idx] = next;
      await window.Storage.saveStores(meal, this.cache[meal]);
      return next;
    },

    async move(mealFrom, mealTo, id, patch = {}) {
      ensureMealCache(this.cache, mealFrom);
      ensureMealCache(this.cache, mealTo);
      const idx = this.cache[mealFrom].findIndex((s) => s.id === id);
      if (idx < 0) return null;

      const source = this.cache[mealFrom][idx];
      const normalizedUrl = normalizeUrl(source.url);
      if (normalizedUrl) {
        const duplicated = this.cache[mealTo].some((s) => normalizeUrl(s.url) === normalizedUrl);
        if (duplicated) {
          throw new Error('이동 대상 탭에 동일한 네이버 지도 URL이 이미 등록되어 있습니다.');
        }
      }

      const moved = { ...source, ...patch };
      this.cache[mealFrom].splice(idx, 1);
      this.cache[mealTo].push(moved);
      await window.Storage.saveStores(mealFrom, this.cache[mealFrom]);
      await window.Storage.saveStores(mealTo, this.cache[mealTo]);
      return moved;
    },

    get(meal) {
      ensureMealCache(this.cache, meal);
      return this.cache[meal] || [];
    },

    getById(meal, id) {
      return this.get(meal).find((s) => s.id === id) || null;
    },

    /** Pick N unique random stores. */
    pickRandom(meal, n) {
      const arr = [...this.get(meal)];
      const out = [];
      while (arr.length && out.length < n) {
        const idx = Math.floor(Math.random() * arr.length);
        out.push(arr.splice(idx, 1)[0]);
      }
      return out;
    },
  };

  function normalizeNameList(input) {
    if (!Array.isArray(input)) return [];
    return Array.from(new Set(input.map((x) => String(x || '').trim()).filter(Boolean)));
  }

  window.Stores = Stores;
})();
