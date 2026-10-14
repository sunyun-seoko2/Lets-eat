/**
 * 룰렛 순수 로직 (js/app.js, js/week-history.js, js/maps.js 의 포팅).
 * 브라우저 폴백과 같은 결과가 나와야 하므로 동작을 임의로 바꾸지 말 것.
 */
const MEAL_TYPES = ['lunch', 'dinner', 'fridayLunch'];
const ASSIGNMENT_PIN_GROUPS = ['outside', 'lunchbox', 'pool'];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- 서울 시간 ----------
function getSeoulDateTimeParts(ts = Date.now()) {
  const d = new Date(Number(ts) + KST_OFFSET_MS); // 한국은 DST 없음
  const p2 = (n) => String(n).padStart(2, '0');
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    dateKey: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    weekday: WEEKDAYS[d.getUTCDay()],
    weekdayNum: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

function seoulWallTimeToMs(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0);
}

// ---------- 주간 기록 규칙 (week-history.js) ----------
function daysBackToSaturday(ts) {
  const p = getSeoulDateTimeParts(ts);
  const wd = p.weekdayNum;
  if (wd === 6) return (p.hour < 10) ? 7 : 0;
  if (wd === 0) return 1;
  return wd + 1;
}

function getLatestPassedSaturday10Ms(ts = Date.now()) {
  const sat = getSeoulDateTimeParts(ts - daysBackToSaturday(ts) * DAY_MS);
  return seoulWallTimeToMs(sat.year, sat.month, sat.day, 10, 0);
}

function isWorkdayForRecording(ts = Date.now()) {
  const wd = getSeoulDateTimeParts(ts).weekdayNum;
  return wd >= 1 && wd <= 5;
}

function filterActiveRecords(rows, ts = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  const boundary = getLatestPassedSaturday10Ms(ts);
  return list.filter((r) => Number(r.createdAt || 0) >= boundary);
}

// ---------- 자동 룰렛 ----------
function getAutoRouletteMealToday(parts) {
  if (['Mon', 'Tue', 'Wed', 'Thu'].includes(parts.weekday)) return 'lunch';
  if (parts.weekday === 'Fri') return 'fridayLunch';
  return null;
}

function hasAutoRouletteRunToday(session, todayKey) {
  if (!session) return false;
  if (session.autoRunDate === todayKey) return true;
  const spunTs = Number(session.spunAt || session.startAt || 0);
  return Boolean(session.winnerId && spunTs
    && getSeoulDateTimeParts(spunTs).dateKey === todayKey);
}

function createSeededRandom(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i += 1) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 가게 ----------
function normalizeUrlForCompare(url) {
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

function storeDedupKey(s) {
  const nameKey = String(s.name || '').trim().toLowerCase().replace(/\s+/g, '');
  if (nameKey) return `name:${nameKey}`;
  const urlKey = normalizeUrlForCompare(s.url);
  if (urlKey) return `url:${urlKey}`;
  return `id:${s.id}`;
}

function dedupeStoresByUrl(stores) {
  const seen = new Set();
  const out = [];
  stores.forEach((s) => {
    const key = storeDedupKey(s);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  });
  return out;
}

function getStoreVisibleMeals(store, sourceMeal) {
  if (Array.isArray(store.visibleMeals) && store.visibleMeals.length) {
    return [...new Set(store.visibleMeals.filter((m) => MEAL_TYPES.includes(m)))];
  }
  const meals = [sourceMeal];
  if (store.showInFridayLunchTab || store.showInCompanionLunchTab) meals.push('fridayLunch');
  return [...new Set(meals)];
}

/** storesByMeal: { lunch: [], dinner: [], fridayLunch: [] } */
function getVisibleStoresForMeal(storesByMeal, targetMeal) {
  const merged = [];
  MEAL_TYPES.forEach((baseMeal) => {
    (storesByMeal[baseMeal] || []).forEach((store) => {
      if (getStoreVisibleMeals(store, baseMeal).includes(targetMeal)) merged.push(store);
    });
  });
  return dedupeStoresByUrl(merged);
}

/** 세 PK 전체에서 id 로 가게 찾기 (다른 탭에서 미러링된 가게도 찾음) */
function findStoreById(storesByMeal, id) {
  for (const meal of MEAL_TYPES) {
    const found = (storesByMeal[meal] || []).find((s) => s.id === id);
    if (found) return found;
  }
  return null;
}

// ---------- 사람 / 입맛 보호 / 고정(pin) ----------
function normalizePeopleNames(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((p) => (typeof p === 'string' ? p.trim() : (p && p.name ? String(p.name).trim() : '')))
    .filter(Boolean);
}

function normalizeCautions(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((c) => ({
      name: c && c.name ? String(c.name).trim() : '',
      note: c && c.note ? String(c.note).trim() : '',
    }))
    .filter((c) => c.name && c.note);
}

function normalizeCautionStoreBlocks(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  Object.entries(input).forEach(([name, keys]) => {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) return;
    const list = Array.isArray(keys) ? keys : [];
    const cleaned = Array.from(new Set(list.map((k) => String(k || '').trim()).filter(Boolean)));
    if (cleaned.length) out[normalizedName] = cleaned;
  });
  return out;
}

function normalizeAssignmentPins(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  Object.entries(input).forEach(([name, pin]) => {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) return;
    const rawGroup = pin && typeof pin === 'object' ? pin.group : pin;
    const group = ASSIGNMENT_PIN_GROUPS.includes(rawGroup) ? rawGroup : 'pool';
    const pinned = pin && typeof pin === 'object' ? pin.pinned !== false : true;
    if (!pinned) return;
    out[normalizedName] = { group, pinned: true };
  });
  return out;
}

// 월~목 10:50~13:30 에만 고정 배정이 적용됨
function isAssignmentPinEffective(ts) {
  const seoul = getSeoulDateTimeParts(ts);
  const minutes = seoul.hour * 60 + seoul.minute;
  return ['Mon', 'Tue', 'Wed', 'Thu'].includes(seoul.weekday)
    && minutes >= (10 * 60 + 50)
    && minutes < (13 * 60 + 30);
}

/** 저장된 people 번들 -> 룰렛에 필요한 상태 (loadPeopleData 포팅, 저장은 하지 않음) */
function buildPeopleState(bundle, ts = Date.now()) {
  const b = bundle && typeof bundle === 'object' ? bundle : {};
  const names = new Set(normalizePeopleNames(b.people || []));
  const cautions = normalizeCautions(b.cautions || []).filter((c) => names.has(c.name));
  const cautionStoreBlocks = normalizeCautionStoreBlocks(b.cautionStoreBlocks || {});
  Object.keys(cautionStoreBlocks).forEach((name) => {
    if (!names.has(name)) delete cautionStoreBlocks[name];
  });
  const assignmentPins = normalizeAssignmentPins(b.assignmentPins || {});
  Object.keys(assignmentPins).forEach((name) => {
    if (!names.has(name)) delete assignmentPins[name];
  });

  const loaded = b.assignments || { outside: [], lunchbox: [] };
  let outside = Array.isArray(loaded.outside) ? loaded.outside : [];
  let lunchbox = Array.isArray(loaded.lunchbox) ? loaded.lunchbox : [];
  // normalizeAssignments
  outside = Array.from(new Set(outside.filter((n) => names.has(n))));
  lunchbox = Array.from(new Set(lunchbox.filter((n) => names.has(n))));
  const outsideSet = new Set(outside);
  lunchbox = lunchbox.filter((n) => !outsideSet.has(n));
  // applyEffectiveAssignmentPins
  if (isAssignmentPinEffective(ts)) {
    Object.entries(assignmentPins).forEach(([name, pin]) => {
      if (!names.has(name) || !pin || !pin.pinned) return;
      const group = ASSIGNMENT_PIN_GROUPS.includes(pin.group) ? pin.group : 'pool';
      outside = outside.filter((n) => n !== name);
      lunchbox = lunchbox.filter((n) => n !== name);
      if (group === 'outside') outside.push(name);
      if (group === 'lunchbox') lunchbox.push(name);
    });
    outside = Array.from(new Set(outside));
    lunchbox = Array.from(new Set(lunchbox));
  }
  return { cautions, cautionStoreBlocks, assignments: { outside, lunchbox } };
}

// 주의: 클라이언트 pickRandomFromVisible 은 includeMeta 를 쓰지 않아 __sourceMeal 이 없으므로
// URL 이 없는 가게의 차단 키는 대상 식사(meal)를 기준으로 만든다. (그대로 재현)
function getStoreBlockKeyFromStore(store, mealFallback) {
  const normUrl = normalizeUrlForCompare(store && store.url);
  if (normUrl) return `url:${normUrl}`;
  const sourceMeal = (store && store.__sourceMeal) || mealFallback || 'lunch';
  return `id:${sourceMeal}:${store && store.id ? store.id : ''}`;
}

function isBlockedByCaution(store, meal, peopleState) {
  const { cautions, cautionStoreBlocks, assignments } = peopleState;
  const cautionNames = new Set(cautions.map((c) => c.name));
  const eatingOut = assignments.outside.filter((n) => cautionNames.has(n));
  const hasStoreBlocks = assignments.outside.some((name) => {
    const keys = cautionStoreBlocks[name];
    return Array.isArray(keys) && keys.length > 0;
  });
  if (!eatingOut.length && !hasStoreBlocks) return false;
  const blockedFor = Array.isArray(store.avoidFor) ? store.avoidFor : [];
  if (blockedFor.some((name) => eatingOut.includes(name))) return true;
  const blockedStoreKeys = new Set();
  assignments.outside.forEach((name) => {
    const keys = Array.isArray(cautionStoreBlocks[name]) ? cautionStoreBlocks[name] : [];
    keys.forEach((k) => blockedStoreKeys.add(k));
  });
  if (!blockedStoreKeys.size) return false;
  return blockedStoreKeys.has(getStoreBlockKeyFromStore(store, meal));
}

// ---------- 무작위 기록 ----------
function normalizeRandomHistory(rows, meal, ts = Date.now()) {
  return filterActiveRecords(Array.isArray(rows) ? rows : [], ts)
    .filter((r) => r && r.storeId && r.createdAt)
    .map((r) => ({
      id: String(r.id || ''),
      storeId: String(r.storeId),
      storeName: String(r.storeName || ''),
      source: String(r.source || 'unknown'),
      sourceRef: String(r.sourceRef || ''),
      createdAt: Number(r.createdAt || 0),
      meal,
    }));
}

function getRecentRandomBlockedIds(history) {
  return new Set(
    history
      .filter((r) => r.source === 'rouletteWinner' || r.source === 'voteWinner')
      .map((r) => r.storeId)
  );
}

// ---------- 후보 선정 (pickRandomFromVisible 포팅, 시드 난수 전용) ----------
function pickRandomFromVisible(n, meal, random, { storesByMeal, history, peopleState }) {
  const blockedByRecent = getRecentRandomBlockedIds(history);
  const arr = dedupeStoresByUrl(
    getVisibleStoresForMeal(storesByMeal, meal)
      .filter((s) => !isBlockedByCaution(s, meal, peopleState) && !blockedByRecent.has(s.id))
  );
  // 브라우저마다 같은 결과가 나오도록 순서를 고정
  arr.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const out = [];
  while (arr.length && out.length < n) {
    const idx = Math.floor(random() * arr.length);
    out.push(arr.splice(idx, 1)[0]);
  }
  return out;
}

// ---------- 도보 (maps.js) ----------
// 네이버 Geocoder 로 '종로33길 15'(두산아트센터)를 변환한 값, 브라우저 보정 결과와 동일
const FIXED_LOCATION = { name: '연강빌딩', lat: 37.5718135, lng: 127.0010162 };
const WALK_DETOUR_FACTOR = 1.3;
const WALK_METERS_PER_MINUTE = 75;

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function estimateWalk(store) {
  if (!store || store.lat == null || store.lng == null) return null;
  const straightM = distanceMeters(FIXED_LOCATION.lat, FIXED_LOCATION.lng, store.lat, store.lng);
  const walkM = straightM * WALK_DETOUR_FACTOR;
  return {
    straightM: Math.round(straightM),
    walkM: Math.round(walkM),
    minutes: Math.max(1, Math.ceil(walkM / WALK_METERS_PER_MINUTE)),
  };
}

module.exports = {
  MEAL_TYPES,
  getSeoulDateTimeParts,
  getLatestPassedSaturday10Ms,
  isWorkdayForRecording,
  filterActiveRecords,
  getAutoRouletteMealToday,
  hasAutoRouletteRunToday,
  createSeededRandom,
  findStoreById,
  buildPeopleState,
  normalizeRandomHistory,
  pickRandomFromVisible,
  estimateWalk,
};
