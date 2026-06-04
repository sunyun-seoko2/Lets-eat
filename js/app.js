/**
 * App orchestrator. meal tabs + settings UI.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const MEAL_TYPES = ['lunch', 'dinner', 'fridayLunch'];
  const ROULETTE_DEFAULT_LEAD_MS = 2000;
  const ROULETTE_DEFAULT_DURATION_MS = 8000;
  const ROULETTE_LOCK_MESSAGE = '오늘 룰렛은 이미 완료되었습니다. 수동 초기화하거나 다음날 09:00 자동 초기화 후 다시 돌릴 수 있습니다.';

  const state = {
    activeTab: 'lunch',           // meal tab key | 'settings'
    meal: 'lunch',                // 현재 작업 대상 식사 타입
    selectedStoreId: null,
    voteTimer: null,
    pickingForStoreId: null,      // 좌표 지정 모드 대상
    people: [],
    cautions: [],
    cautionStoreBlocks: {},
    assignments: { outside: [], lunchbox: [] },
    assignmentPins: {},
    assignmentsResetState: { lunch: '', night: '' },
    settingsSubtab: 'people',
    randomHistoryByMeal: { lunch: [], dinner: [], fridayLunch: [] },
    rouletteByMeal: { lunch: null, dinner: null, fridayLunch: null },
    rouletteRenderedSessionId: '',
    mainStoreSearch: '',
    settingsStoreSearch: '',
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    updateStorageStatus();
    Maps.init('map');
    Roulette.init('roulette-canvas');

    bindTabs();
    bindStoreForm();
    bindAutoAdd();
    bindStoreSearch();
    bindRoulette();
    bindVoting();
    bindPeopleAndCautions();
    bindSettingsSubtabs();
    bindRandomHistoryManager();
    bindTitleQuickSwitch();
    bindMapActions();
    bindStorageErrors();

    await maybeWeeklyHistoryReset();
    // 식사 타입 데이터 미리 로드
    for (const meal of MEAL_TYPES) {
      await Stores.load(meal);
      await Voting.load(meal);
      await loadRandomHistoryForMeal(meal);
      await loadRouletteForMeal(meal);
    }
    await loadPeopleData();

    await switchTab(getInitialMealTabBySeoulTime());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && Maps.isPickMode()) cancelPickMode();
    });

    startPolling();
    startDailyAssignmentsResetWatcher();
    startWeeklyHistoryResetWatcher();
    startVoteAutoResetWatcher();
    startRouletteAutoResetWatcher();
    startTodayGroupTitleWatcher();
    updateTodayGroupTitle();
    renderPeopleAndAssignments();
    renderCautions();
  }

  function updateStorageStatus() {
    const el = $('#storage-status');
    if (!el) return;
    const mode = window.AppConfig && window.AppConfig.storage;
    if (mode === 'azure') {
      const acct = (window.AppConfig.azure && window.AppConfig.azure.account) || '?';
      el.innerHTML = `☁️ Azure Tables 연결됨 (<code>${acct}</code>) · 실시간 공유 모드`;
    } else {
      el.textContent = '💾 localStorage (이 브라우저에만 저장)';
    }
  }

  const PEOPLE_KEY = 'ls.people.v1';
  const CAUTION_KEY = 'ls.cautions.v1';
  const ASSIGN_KEY = 'ls.assignments.v1';
  const ASSIGNMENT_PINS_KEY = 'ls.assignmentPins.v1';
  const ASSIGN_RESET_KEY = 'ls.assignments.reset.date.v1';
  const ASSIGN_RESET_SCHEDULE_KEY = 'ls.assignments.reset.schedule.v1';
  const ASSIGNMENT_PIN_GROUPS = ['outside', 'lunchbox', 'pool'];
  const ROLE_OPTIONS = ['사원 (선임)', '대리', '과장', '차장', '부장', '이사', '팀장님'];
  const HISTORY_ADMIN_PASSWORD = 'MTP2026';

  async function loadPeopleData() {
    let bundle = null;
    if (window.Storage && typeof window.Storage.getPeopleBundle === 'function') {
      try {
        bundle = await window.Storage.getPeopleBundle();
      } catch (e) {
        console.warn('getPeopleBundle failed, fallback to local:', e);
      }
    }
    if (!bundle) {
      bundle = {
        people: safeLocalParse(PEOPLE_KEY, []),
        cautions: safeLocalParse(CAUTION_KEY, []),
        cautionStoreBlocks: {},
        assignments: safeLocalParse(ASSIGN_KEY, { outside: [], lunchbox: [] }),
        assignmentPins: safeLocalParse(ASSIGNMENT_PINS_KEY, {}),
        resetState: safeLocalParse(ASSIGN_RESET_SCHEDULE_KEY, null) || localStorage.getItem(ASSIGN_RESET_KEY) || '',
      };
    }
    state.people = sortPeopleByRoleAndName(normalizePeople(bundle.people || []));
    state.cautions = normalizeCautions(bundle.cautions || []);
    state.cautionStoreBlocks = normalizeCautionStoreBlocks(bundle.cautionStoreBlocks || {});
    state.assignmentPins = normalizeAssignmentPins(bundle.assignmentPins || safeLocalParse(ASSIGNMENT_PINS_KEY, {}));
    const peopleNames = new Set(state.people.map((p) => p.name));
    state.cautions = state.cautions.filter((c) => peopleNames.has(c.name));
    Object.keys(state.cautionStoreBlocks).forEach((name) => {
      if (!peopleNames.has(name)) delete state.cautionStoreBlocks[name];
    });
    Object.keys(state.assignmentPins).forEach((name) => {
      if (!peopleNames.has(name)) delete state.assignmentPins[name];
    });
    const loadedAssign = bundle.assignments || { outside: [], lunchbox: [] };
    state.assignments = {
      outside: Array.isArray(loadedAssign.outside) ? loadedAssign.outside : [],
      lunchbox: Array.isArray(loadedAssign.lunchbox) ? loadedAssign.lunchbox : [],
    };
    state.assignmentsResetState = normalizeAssignmentsResetState(bundle.resetState || bundle.resetDate || '');
    const normalized = normalizeAssignments();
    const resetDone = maybeResetAssignmentsBySchedule();
    if (normalized && !resetDone) persistPeopleBundle();
  }

  function savePeopleData() {
    persistPeopleBundle();
  }

  function normalizePeople(input) {
    if (!Array.isArray(input)) return [];
    return input
      .map((p) => {
        // 구버전 호환: ["홍길동", ...] 형태도 사람 목록으로 복원
        if (typeof p === 'string') {
          return {
            id: uid('p'),
            name: p.trim(),
            role: '사원 (선임)',
          };
        }
        return {
          id: p && p.id ? String(p.id) : uid('p'),
          name: p && p.name ? String(p.name).trim() : '',
          role: ROLE_OPTIONS.includes(p && p.role) ? p.role : '사원 (선임)',
        };
      })
      .filter((p) => p.name);
  }

  function sortPeopleByRoleAndName(input) {
    const list = Array.isArray(input) ? [...input] : [];
    const roleRank = new Map(ROLE_OPTIONS.map((role, idx) => [role, idx]));
    return list.sort((a, b) => {
      const rankA = roleRank.has(a.role) ? roleRank.get(a.role) : Number.MAX_SAFE_INTEGER;
      const rankB = roleRank.has(b.role) ? roleRank.get(b.role) : Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return String(a.name || '').localeCompare(String(b.name || ''), 'ko');
    });
  }

  function saveCautions() {
    persistPeopleBundle();
  }

  function normalizeCautions(input) {
    if (!Array.isArray(input)) return [];
    return input
      .map((c) => ({
        id: c && c.id ? String(c.id) : uid('c'),
        name: c && c.name ? String(c.name).trim() : '',
        note: c && c.note ? String(c.note).trim() : '',
      }))
      .filter((c) => c.name && c.note);
  }

  function normalizeAssignmentsResetState(input) {
    if (input && typeof input === 'object') {
      return {
        lunch: String(input.lunch || ''),
        night: String(input.night || ''),
      };
    }
    // 구버전 호환: 단일 resetDate 문자열은 점심 초기화 슬롯으로 간주
    const legacy = String(input || '').trim();
    return {
      lunch: legacy,
      night: '',
    };
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
      out[normalizedName] = {
        group,
        pinned: true,
        updatedAt: pin && typeof pin === 'object' && pin.updatedAt ? String(pin.updatedAt) : '',
      };
    });
    return out;
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

  function saveAssignments() {
    normalizeAssignments();
    persistPeopleBundle();
  }

  function persistPeopleBundle() {
    const bundle = {
      people: state.people,
      cautions: state.cautions,
      cautionStoreBlocks: state.cautionStoreBlocks,
      assignments: state.assignments,
      assignmentPins: state.assignmentPins,
      resetState: state.assignmentsResetState,
    };
    if (window.Storage && typeof window.Storage.savePeopleBundle === 'function') {
      window.Storage.savePeopleBundle(bundle).catch((e) => {
        console.warn('savePeopleBundle failed, fallback to local:', e);
        localStorage.setItem(PEOPLE_KEY, JSON.stringify(state.people));
        localStorage.setItem(CAUTION_KEY, JSON.stringify(state.cautions));
        localStorage.setItem(ASSIGN_KEY, JSON.stringify(state.assignments));
        localStorage.setItem(ASSIGNMENT_PINS_KEY, JSON.stringify(state.assignmentPins));
        localStorage.setItem(ASSIGN_RESET_SCHEDULE_KEY, JSON.stringify(state.assignmentsResetState));
      });
      return;
    }
    localStorage.setItem(PEOPLE_KEY, JSON.stringify(state.people));
    localStorage.setItem(CAUTION_KEY, JSON.stringify(state.cautions));
    localStorage.setItem(ASSIGN_KEY, JSON.stringify(state.assignments));
    localStorage.setItem(ASSIGNMENT_PINS_KEY, JSON.stringify(state.assignmentPins));
    localStorage.setItem(ASSIGN_RESET_SCHEDULE_KEY, JSON.stringify(state.assignmentsResetState));
  }

  function safeLocalParse(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function normalizeAssignments() {
    const beforeOutside = (state.assignments.outside || []).join('\u0001');
    const beforeLunchbox = (state.assignments.lunchbox || []).join('\u0001');
    const all = new Set(state.people.map((p) => p.name));
    state.assignments.outside = Array.from(new Set(state.assignments.outside.filter((n) => all.has(n))));
    state.assignments.lunchbox = Array.from(new Set(state.assignments.lunchbox.filter((n) => all.has(n))));
    const outsideSet = new Set(state.assignments.outside);
    state.assignments.lunchbox = state.assignments.lunchbox.filter((n) => !outsideSet.has(n));
    const pinChanged = applyEffectiveAssignmentPins();
    return pinChanged
      || beforeOutside !== state.assignments.outside.join('\u0001')
      || beforeLunchbox !== state.assignments.lunchbox.join('\u0001');
  }

  function getAssignmentPinTimeState(date = new Date()) {
    const seoul = getSeoulDateTimeParts(date);
    const minutesFromMidnight = seoul.hour * 60 + seoul.minute;
    const monToThu = ['Mon', 'Tue', 'Wed', 'Thu'];
    const isFriday = seoul.weekday === 'Fri';
    const dailyRestoreWindow = monToThu.includes(seoul.weekday)
      && minutesFromMidnight >= (10 * 60 + 50)
      && minutesFromMidnight < (13 * 60 + 30);
    return {
      active: dailyRestoreWindow,
      temporarilyReleased: !dailyRestoreWindow && (isFriday || minutesFromMidnight >= (13 * 60 + 30)),
      weekday: seoul.weekday,
      minutesFromMidnight,
    };
  }

  function isAssignmentPinEffectiveNow() {
    return getAssignmentPinTimeState().active;
  }

  function isPersonManuallyPinned(name) {
    return Boolean(state.assignmentPins[name] && state.assignmentPins[name].pinned);
  }

  function applyEffectiveAssignmentPins() {
    if (!isAssignmentPinEffectiveNow()) return false;
    const beforeOutside = (state.assignments.outside || []).join('\u0001');
    const beforeLunchbox = (state.assignments.lunchbox || []).join('\u0001');
    const all = new Set(state.people.map((p) => p.name));
    Object.entries(state.assignmentPins).forEach(([name, pin]) => {
      if (!all.has(name) || !pin || !pin.pinned) return;
      const group = ASSIGNMENT_PIN_GROUPS.includes(pin.group) ? pin.group : 'pool';
      state.assignments.outside = state.assignments.outside.filter((n) => n !== name);
      state.assignments.lunchbox = state.assignments.lunchbox.filter((n) => n !== name);
      if (group === 'outside') state.assignments.outside.push(name);
      if (group === 'lunchbox') state.assignments.lunchbox.push(name);
    });
    state.assignments.outside = Array.from(new Set(state.assignments.outside));
    state.assignments.lunchbox = Array.from(new Set(state.assignments.lunchbox));
    return beforeOutside !== state.assignments.outside.join('\u0001')
      || beforeLunchbox !== state.assignments.lunchbox.join('\u0001');
  }

  function buildAssignmentsFromEffectivePins() {
    const next = { outside: [], lunchbox: [] };
    if (!isAssignmentPinEffectiveNow()) return next;
    const all = new Set(state.people.map((p) => p.name));
    Object.entries(state.assignmentPins).forEach(([name, pin]) => {
      if (!all.has(name) || !pin || !pin.pinned) return;
      const group = ASSIGNMENT_PIN_GROUPS.includes(pin.group) ? pin.group : 'pool';
      if (group === 'outside') next.outside.push(name);
      if (group === 'lunchbox') next.lunchbox.push(name);
    });
    return {
      outside: Array.from(new Set(next.outside)),
      lunchbox: Array.from(new Set(next.lunchbox)),
    };
  }

  function setAssignmentPin(name, group) {
    if (!ASSIGNMENT_PIN_GROUPS.includes(group)) return;
    state.assignmentPins[name] = {
      group,
      pinned: true,
      updatedAt: new Date().toISOString(),
    };
  }

  function clearAssignmentPin(name) {
    delete state.assignmentPins[name];
  }

  function sortNamesByRoleAndName(names) {
    const roleRank = new Map(ROLE_OPTIONS.map((role, idx) => [role, idx]));
    const peopleByName = new Map(state.people.map((p) => [p.name, p]));
    return [...names].sort((a, b) => {
      const pa = peopleByName.get(a);
      const pb = peopleByName.get(b);
      const rankA = pa && roleRank.has(pa.role) ? roleRank.get(pa.role) : Number.MAX_SAFE_INTEGER;
      const rankB = pb && roleRank.has(pb.role) ? roleRank.get(pb.role) : Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return String(a || '').localeCompare(String(b || ''), 'ko');
    });
  }

  function maybeResetAssignmentsBySchedule() {
    const seoul = getSeoulDateTimeParts();
    const minutesFromMidnight = seoul.hour * 60 + seoul.minute;
    let didReset = false;
    const nextState = normalizeAssignmentsResetState(state.assignmentsResetState);

    // 1차 초기화: 매일 13:30 이후 1회
    if (minutesFromMidnight >= (13 * 60 + 30) && nextState.lunch !== seoul.dateKey) {
      didReset = true;
      nextState.lunch = seoul.dateKey;
    }
    // 2차 초기화: 매일 21:00 이후 1회
    if (minutesFromMidnight >= (21 * 60) && nextState.night !== seoul.dateKey) {
      didReset = true;
      nextState.night = seoul.dateKey;
    }

    if (!didReset) return false;
    state.assignments = buildAssignmentsFromEffectivePins();
    state.assignmentsResetState = nextState;
    saveAssignments();
    return true;
  }

  function startDailyAssignmentsResetWatcher() {
    setInterval(() => {
      const resetDone = maybeResetAssignmentsBySchedule();
      const pinChanged = resetDone ? false : normalizeAssignments();
      if (pinChanged) persistPeopleBundle();
      updateTodayGroupTitle();
      if (!resetDone && !pinChanged) return;
      renderPeopleAndAssignments();
      if (MEAL_TYPES.includes(state.activeTab)) {
        renderStoreList();
        Maps.renderStores(getVisibleStores());
      }
    }, 60 * 1000);
  }

  async function maybeWeeklyHistoryReset() {
    if (!window.WeekHistory || !window.Storage) return false;
    const getAt = window.Storage.getWeeklyResetAt;
    const setAt = window.Storage.setWeeklyResetAt;
    if (typeof getAt !== 'function' || typeof setAt !== 'function') return false;

    const lastResetAt = await getAt();
    if (!window.WeekHistory.shouldRunWeeklyReset(lastResetAt)) return false;

    for (const meal of MEAL_TYPES) {
      if (typeof window.Storage.clearRandomHistory === 'function') {
        await window.Storage.clearRandomHistory(meal);
      }
      if (typeof window.Storage.clearVoteHistory === 'function') {
        await window.Storage.clearVoteHistory(meal);
      }
      state.randomHistoryByMeal[meal] = [];
      if (window.Voting && Voting.history) Voting.history[meal] = [];
    }

    const boundary = window.WeekHistory.getLatestPassedSaturday10Ms();
    await setAt(boundary || Date.now());
    return true;
  }

  function startWeeklyHistoryResetWatcher() {
    setInterval(async () => {
      try {
        const resetDone = await maybeWeeklyHistoryReset();
        if (!resetDone) return;
        for (const meal of MEAL_TYPES) {
          await loadRandomHistoryForMeal(meal);
          if (window.Voting && typeof Voting.loadHistory === 'function') {
            await Voting.loadHistory(meal);
          }
        }
        if (state.settingsSubtab === 'history') renderRandomHistoryManager();
        if (MEAL_TYPES.includes(state.activeTab)) {
          renderVote();
          renderStoreList();
        }
      } catch (e) {
        console.warn('weekly history reset watcher failed:', e);
      }
    }, 60 * 1000);
  }

  function getSeoulDateTimeParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const year = parts.find((p) => p.type === 'year')?.value || '0000';
    const month = parts.find((p) => p.type === 'month')?.value || '01';
    const day = parts.find((p) => p.type === 'day')?.value || '01';
    const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return {
      dateKey: `${year}-${month}-${day}`,
      weekday,
      hour,
      minute,
    };
  }

  function updateTodayGroupTitle() {
    const titleEl = $('#today-group-title');
    if (!titleEl) return;
    titleEl.textContent = getTodayGroupTitleBySeoulTime();
  }

  function getTodayGroupTitleBySeoulTime() {
    // 사용자가 식사 탭을 직접 선택한 경우 탭 기준 문구를 우선 반영
    if (state.activeTab === 'lunch' || state.activeTab === 'fridayLunch') {
      return '오늘 점심🍽️';
    }
    if (state.activeTab === 'dinner') {
      return '오늘 저녁 및 회식🍺';
    }

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    const minutesFromMidnight = hour * 60 + minute;
    const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);

    if (isWeekday && minutesFromMidnight >= (9 * 60) && minutesFromMidnight <= (13 * 60)) {
      return '오늘 점심🍽️';
    }
    if (isWeekday && minutesFromMidnight >= (13 * 60 + 1) && minutesFromMidnight <= (19 * 60 + 30)) {
      return '오늘 저녁 및 회식🍺';
    }
    return '오늘 점심🍽️';
  }

  function startTodayGroupTitleWatcher() {
    setInterval(() => {
      updateTodayGroupTitle();
    }, 60 * 1000);
  }

  // ---------- 실시간 폴링 (Azure 모드일 때 데이터 동기화) ----------
  let pollTimerHandle = null;
  let pollCurrentMs = 0;

  function startPolling() {
    if (!window.AppConfig || window.AppConfig.storage !== 'azure') return;
    schedulePoll();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        pollNow();
        schedulePoll();
      }
    });
  }

  function startVoteAutoResetWatcher() {
    let running = false;
    setInterval(async () => {
      if (running) return;
      running = true;
      try {
        for (const meal of MEAL_TYPES) {
          await Voting.load(meal);
        }
        if (MEAL_TYPES.includes(state.activeTab)) {
          renderVote();
        }
      } catch (e) {
        console.warn('vote auto reset watcher failed:', e);
      } finally {
        running = false;
      }
    }, 60 * 1000);
  }

  function schedulePoll() {
    const v = Voting.get(state.meal);
    const voteOpen = v && Voting.status(v) === 'open';
    const rouletteSpinning = isRouletteSpinning(state.meal);
    const desired = rouletteSpinning
      ? (window.AppConfig.pollIntervalRouletteMs || 1000)
      : voteOpen
        ? (window.AppConfig.pollIntervalVoteMs || 3000)
        : (window.AppConfig.pollIntervalMs || 3000);
    if (desired === pollCurrentMs && pollTimerHandle) return;
    if (pollTimerHandle) clearInterval(pollTimerHandle);
    pollCurrentMs = desired;
    pollTimerHandle = setInterval(pollNow, desired);
  }

  async function pollNow() {
    if (document.visibilityState === 'hidden') return;
    if (state.pickingForStoreId) return; // 좌표 지정 중에는 방해 X
    try {
      await maybeWeeklyHistoryReset();
      for (const meal of MEAL_TYPES) {
        await Stores.load(meal);
        await loadRandomHistoryForMeal(meal);
        await loadRouletteForMeal(meal);
      }
      await Voting.load(state.meal);
      await loadPeopleData();
    } catch (e) {
      console.warn('poll failed:', e);
      return;
    }
    renderPeopleAndAssignments();
    renderCautions();
    // 활성 탭 기준으로 UI 갱신
    if (MEAL_TYPES.includes(state.activeTab)) {
      renderStoreList();
      Maps.renderStores(getVisibleStores());
      renderVote();
      renderRouletteFromShared();
    } else if (state.activeTab === 'settings') {
      renderSettingsStoreList();
      if (state.settingsSubtab === 'history') renderRandomHistoryManager();
    }
    schedulePoll();
  }

  // ---------- Tabs ----------
  function bindTabs() {
    $$('.meal-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    // settings 안의 식사 선택 라디오
    $$('input[name="reg-meal"]').forEach((r) => {
      r.addEventListener('change', () => {
        state.meal = r.value;
        renderSettingsStoreList();
      });
    });
  }

  function bindSettingsSubtabs() {
    $$('.settings-subtab').forEach((btn) => {
      btn.addEventListener('click', () => switchSettingsSubtab(btn.dataset.settingsTab));
    });
  }

  function bindStoreSearch() {
    const mainSearch = $('#store-search-main');
    if (mainSearch) {
      mainSearch.addEventListener('input', () => {
        state.mainStoreSearch = (mainSearch.value || '').trim().toLowerCase();
        renderStoreList();
      });
    }

    const syncSettingsSearch = (nextValue, sourceEl) => {
      state.settingsStoreSearch = (nextValue || '').trim().toLowerCase();
      const top = $('#store-search-settings-top');
      const list = $('#store-search-settings-list');
      [top, list].forEach((el) => {
        if (!el || el === sourceEl) return;
        el.value = nextValue || '';
      });
      if (state.activeTab === 'settings') renderSettingsStoreList();
    };

    const settingsTop = $('#store-search-settings-top');
    if (settingsTop) {
      settingsTop.addEventListener('input', () => {
        syncSettingsSearch(settingsTop.value, settingsTop);
      });
    }
    const settingsList = $('#store-search-settings-list');
    if (settingsList) {
      settingsList.addEventListener('input', () => {
        syncSettingsSearch(settingsList.value, settingsList);
      });
    }
  }


  function switchSettingsSubtab(tab) {
    state.settingsSubtab = tab;
    $$('.settings-subtab').forEach((b) => b.classList.toggle('active', b.dataset.settingsTab === tab));
    $$('.settings-subpanel').forEach((panel) =>
      panel.classList.toggle('hidden', panel.dataset.settingsPanel !== tab)
    );
    if (tab === 'taste-care') {
      renderCautionPersonOptions();
    }
    if (tab === 'history') {
      Promise.all(MEAL_TYPES.map((meal) => loadRandomHistoryForMeal(meal)))
        .then(() => renderRandomHistoryManager());
    }
  }

  function bindPeopleAndCautions() {
    const addPersonBtn = $('#btn-add-person');
    if (addPersonBtn) {
      addPersonBtn.addEventListener('click', async () => {
        const input = $('#person-name');
        const roleEl = $('#person-role');
        const name = (input && input.value || '').trim();
        const role = roleEl && ROLE_OPTIONS.includes(roleEl.value) ? roleEl.value : '사원 (선임)';
        if (!name) return;
        if (state.people.some((p) => p.name === name)) {
          await showAppAlert('대상자 추가', '이미 등록된 대상자입니다.');
          return;
        }
        state.people.push({ id: uid('p'), name, role });
        state.people = sortPeopleByRoleAndName(state.people);
        if (input) input.value = '';
        if (roleEl) roleEl.value = '사원 (선임)';
        savePeopleData();
        saveAssignments();
        renderPeopleAndAssignments();
        renderCautions();
        renderCautionPersonOptions();
      });
    }

    const addCautionBtn = $('#btn-add-caution');
    if (addCautionBtn) {
      addCautionBtn.addEventListener('click', async () => {
        const nameEl = $('#caution-person');
        const noteEl = $('#caution-note');
        const name = (nameEl && nameEl.value || '').trim();
        const note = (noteEl && noteEl.value || '').trim();
        if (!name || !note) {
          await showAppAlert('입맛 보호 대상자', '대상자와 주의 내용을 모두 입력해주세요.');
          return;
        }
        if (state.cautions.some((c) => c.name === name && c.note === note)) {
          await showAppAlert('입맛 보호 대상자', '이미 동일한 주의 태그가 등록되어 있습니다.');
          return;
        }
        state.cautions.push({ id: uid('c'), name, note });
        if (noteEl) noteEl.value = '';
        saveCautions();
        renderCautions();
      });
    }

    const cautionPersonEl = $('#caution-person');
    if (cautionPersonEl) {
      cautionPersonEl.addEventListener('change', () => {
        renderCautionStoreBlockSummary();
      });
    }

    const cautionStoreBtn = $('#btn-caution-store-blocks');
    if (cautionStoreBtn) {
      cautionStoreBtn.addEventListener('click', async () => {
        const personEl = $('#caution-person');
        const personName = (personEl && personEl.value || '').trim();
        if (!personName) {
          await showAppAlert('못가는 가게 선택', '먼저 대상자를 선택해주세요.');
          return;
        }
        const selected = await openCautionStoreBlocksEditor(personName);
        if (!selected) return;
        if (selected.length) state.cautionStoreBlocks[personName] = selected;
        else delete state.cautionStoreBlocks[personName];
        saveCautions();
        renderCautions();
        renderCautionStoreBlockSummary();
      });
    }

    ['outside', 'lunchbox', 'pool'].forEach((group) => {
      const zone = $(`#drop-${group}`);
      if (!zone) return;
      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const name = e.dataTransfer && e.dataTransfer.getData('text/plain');
        if (!name) return;
        movePersonToGroup(name, group);
      });
    });
  }

  function movePersonToGroup(name, group) {
    state.assignments.outside = state.assignments.outside.filter((n) => n !== name);
    state.assignments.lunchbox = state.assignments.lunchbox.filter((n) => n !== name);
    if (group === 'outside') state.assignments.outside.push(name);
    if (group === 'lunchbox') state.assignments.lunchbox.push(name);
    if (state.assignmentPins[name] && state.assignmentPins[name].pinned) {
      setAssignmentPin(name, group);
    }
    saveAssignments();
    renderPeopleAndAssignments();
  }

  function renderPeopleAndAssignments() {
    const normalized = normalizeAssignments();
    if (normalized) persistPeopleBundle();
    renderCautionPersonOptions();
    renderPersonSettingsList();

    const outside = $('#drop-outside');
    const lunchbox = $('#drop-lunchbox');
    const pool = $('#drop-pool');
    if (!outside || !lunchbox || !pool) return;
    outside.innerHTML = '';
    lunchbox.innerHTML = '';
    pool.innerHTML = '';

    const outsideSet = new Set(state.assignments.outside);
    const lunchboxSet = new Set(state.assignments.lunchbox);
    const allNames = state.people.map((p) => p.name);
    const poolNames = sortNamesByRoleAndName(allNames.filter((n) => !outsideSet.has(n) && !lunchboxSet.has(n)));
    const outsideNames = sortNamesByRoleAndName(state.assignments.outside);
    const lunchboxNames = sortNamesByRoleAndName(state.assignments.lunchbox);

    outsideNames.forEach((name) => outside.appendChild(buildPersonTag(name, 'outside')));
    lunchboxNames.forEach((name) => lunchbox.appendChild(buildPersonTag(name, 'lunchbox')));
    poolNames.forEach((name) => pool.appendChild(buildPersonTag(name, 'pool')));

    $('#count-outside').textContent = `총 ${state.assignments.outside.length}명`;
    $('#count-lunchbox').textContent = `총 ${state.assignments.lunchbox.length}명`;
    const poolCount = $('#count-pool');
    if (poolCount) poolCount.textContent = `총 ${poolNames.length}명`;
  }

  function buildPersonTag(name, currentGroup = 'pool') {
    const cautionNotes = getCautionNotesByName(name);
    const hasCaution = cautionNotes.length > 0;
    const tag = document.createElement('span');
    tag.className = 'person-tag';
    tag.draggable = true;
    tag.dataset.group = currentGroup;
    tag.tabIndex = 0;
    tag.setAttribute('role', 'button');
    tag.setAttribute('aria-label', `${formatPersonLabel(name)} 이동 메뉴`);
    tag.textContent = '';
    const pin = state.assignmentPins[name];
    const isPinned = Boolean(pin && pin.pinned);
    const pinActive = isPinned && isAssignmentPinEffectiveNow();
    tag.classList.toggle('is-pinned', isPinned);
    tag.classList.toggle('is-pin-active', pinActive);
    tag.classList.toggle('is-pin-paused', isPinned && !pinActive);
    const label = document.createElement('span');
    label.className = 'person-tag-label';
    const personText = formatPersonLabel(name);
    label.textContent = hasCaution ? `📢 ${personText}` : personText;
    tag.appendChild(label);
    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'person-pin-btn';
    pinBtn.dataset.action = 'assignment-pin';
    pinBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="person-pin-body" d="M15.5 3.2 20.8 8.5 18.9 10.4 17.4 8.9 13.2 13.1 13.4 16.4 12.1 17.7 6.3 11.9 7.6 10.6 10.9 10.8 15.1 6.6 13.6 5.1z"/><path class="person-pin-needle-outline" d="M10.2 15.2 5.1 20.3"/><path class="person-pin-needle" d="M10.2 15.2 5.1 20.3"/></svg>';
    pinBtn.setAttribute('aria-label', `${formatPersonLabel(name)} 고정 메뉴`);
    tag.appendChild(pinBtn);
    if (hasCaution) {
      tag.title = `입맛 보호 메모\n- ${cautionNotes.join('\n- ')}`;
    } else {
      tag.removeAttribute('title');
    }
    pinBtn.title = isPinned
      ? (pinActive ? '고정 적용 중' : '고정 일시 해제 중')
      : '현재 위치 고정';
    pinBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showAssignmentPinMenu(name, currentGroup);
    });
    tag.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', name);
      e.dataTransfer.effectAllowed = 'move';
    });
    tag.addEventListener('click', (e) => {
      if (!isMobileAssignmentMode()) return;
      e.preventDefault();
      showMobileAssignmentMenu(name, currentGroup).then((selectedGroup) => {
        if (!selectedGroup) return;
        movePersonToGroup(name, selectedGroup);
      });
    });
    tag.addEventListener('keydown', (e) => {
      if (!isMobileAssignmentMode()) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      showMobileAssignmentMenu(name, currentGroup).then((selectedGroup) => {
        if (!selectedGroup) return;
        movePersonToGroup(name, selectedGroup);
      });
    });
    return tag;
  }

  function isMobileAssignmentMode() {
    if (!window.matchMedia) return false;
    return window.matchMedia('(max-width: 1024px)').matches
      || window.matchMedia('(pointer: coarse)').matches;
  }

  function assignmentGroupLabel(group) {
    return ({
      outside: '외식 파견단',
      lunchbox: '도시락 본부',
      pool: '대상자',
    }[group] || group);
  }

  function getAssignmentPinStatusText(name) {
    const pin = state.assignmentPins[name];
    if (!pin || !pin.pinned) {
      return '현재 위치를 고정하면 월~목 점심 시간에는 초기화에서 제외됩니다.';
    }
    const timeState = getAssignmentPinTimeState();
    const groupLabel = assignmentGroupLabel(pin.group || 'pool');
    if (timeState.active) {
      return `고정 적용 중: ${groupLabel} 위치를 유지합니다.`;
    }
    if (timeState.temporarilyReleased) {
      return `현재는 고정 해제 시간입니다. ${groupLabel} 고정은 저장되어 있으며 다음 적용 시간에 다시 유지됩니다.`;
    }
    return `고정 대기 중: ${groupLabel} 고정은 저장되어 있습니다.`;
  }

  function showAssignmentPinMenu(name, currentGroup) {
    const isPinned = isPersonManuallyPinned(name);
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'visibility-modal-backdrop';
      backdrop.innerHTML = `
        <div class="visibility-modal assignment-pin-modal" role="dialog" aria-modal="true">
          <h3>${escapeHtml(formatPersonLabel(name))}</h3>
          <p class="muted">${escapeHtml(getAssignmentPinStatusText(name))}</p>
          <div class="assignment-pin-help">
            <div><strong>적용</strong><span>월~목 10:50~13:30 점심 고정</span></div>
            <div><strong>해제</strong><span>13:30 이후, 금요일</span></div>
            <div><strong>재적용</strong><span>다음날 10:50부터, 금요일은 차주 월요일 10:50</span></div>
          </div>
          <div class="assignment-move-actions">
            <button type="button" data-action="pin">${escapeHtml(isPinned ? '현재 위치로 고정 갱신' : '현재 위치 고정')}</button>
            ${isPinned ? '<button type="button" data-action="unpin">고정 해제</button>' : ''}
          </div>
          <div class="actions">
            <button type="button" data-action="cancel">취소</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);

      const close = (changed) => {
        backdrop.remove();
        resolve(Boolean(changed));
      };
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(false);
      });
      backdrop.querySelector('[data-action="cancel"]').addEventListener('click', () => close(false));
      const pinBtn = backdrop.querySelector('[data-action="pin"]');
      if (pinBtn) {
        pinBtn.addEventListener('click', () => {
          setAssignmentPin(name, currentGroup);
          saveAssignments();
          renderPeopleAndAssignments();
          close(true);
        });
      }
      const unpinBtn = backdrop.querySelector('[data-action="unpin"]');
      if (unpinBtn) {
        unpinBtn.addEventListener('click', () => {
          clearAssignmentPin(name);
          saveAssignments();
          renderPeopleAndAssignments();
          close(true);
        });
      }
    });
  }

  function showMobileAssignmentMenu(name, currentGroup) {
    if (!isMobileAssignmentMode()) return Promise.resolve(null);
    const groups = ['outside', 'lunchbox', 'pool'].filter((group) => group !== currentGroup);
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'visibility-modal-backdrop';
      backdrop.innerHTML = `
        <div class="visibility-modal assignment-move-modal" role="dialog" aria-modal="true">
          <h3>${escapeHtml(formatPersonLabel(name))}</h3>
          <p class="muted">이동할 위치를 선택하세요.</p>
          <div class="assignment-move-actions">
            ${groups.map((group) => (
              `<button type="button" data-group="${group}">${escapeHtml(assignmentGroupLabel(group))}</button>`
            )).join('')}
          </div>
          <div class="actions">
            <button type="button" data-action="cancel">취소</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);

      const close = (selectedGroup) => {
        backdrop.remove();
        resolve(selectedGroup || null);
      };
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(null);
      });
      backdrop.querySelector('[data-action="cancel"]').addEventListener('click', () => close(null));
      Array.from(backdrop.querySelectorAll('[data-group]')).forEach((btn) => {
        btn.addEventListener('click', () => close(btn.dataset.group));
      });
    });
  }

  function formatPersonLabel(name) {
    const matched = state.people.find((p) => p.name === name);
    return matched && matched.role ? `${name} ${matched.role}` : name;
  }

  function renderPersonSettingsList() {
    const list = $('#person-list');
    if (!list) return;
    list.innerHTML = '';
    if (!state.people.length) {
      list.innerHTML = '<li style="border:none;background:transparent;color:#888;justify-content:center">등록된 대상자가 없습니다.</li>';
      return;
    }
    state.people.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div>
          <div class="s-name">${escapeHtml(p.name)}</div>
          <div class="s-meta">${escapeHtml(p.role)}</div>
        </div>
        <div class="s-actions">
          <button data-action="edit">✏️</button>
          <button data-action="delete">삭제</button>
        </div>`;
      li.addEventListener('click', (e) => {
        const action = e.target.dataset && e.target.dataset.action;
        if (action === 'edit') {
          editPerson(p.id);
          return;
        }
        if (action !== 'delete') return;
        state.cautions = state.cautions.filter((c) => c.name !== p.name);
        delete state.cautionStoreBlocks[p.name];
        clearAssignmentPin(p.name);
        state.people = state.people.filter((x) => x.id !== p.id);
        savePeopleData();
        saveCautions();
        saveAssignments();
        renderPeopleAndAssignments();
        renderCautions();
      });
      list.appendChild(li);
    });
  }

  async function editPerson(personId) {
    const idx = state.people.findIndex((p) => p.id === personId);
    if (idx < 0) return;
    const current = state.people[idx];
    const nextName = await promptAppDialog('대상자 이름 수정', '대상자 이름을 수정하세요.', current.name);
    if (nextName == null) return;
    const name = nextName.trim();
    if (!name) {
      await showAppAlert('대상자 이름 수정', '이름은 비워둘 수 없습니다.');
      return;
    }
    if (state.people.some((p, i) => i !== idx && p.name === name)) {
      await showAppAlert('대상자 이름 수정', '이미 등록된 대상자 이름입니다.');
      return;
    }
    const nextRole = await promptAppDialog(
      '대상자 직책 수정',
      `직책을 입력하세요. 가능: ${ROLE_OPTIONS.join(', ')}`,
      current.role || '사원 (선임)'
    );
    if (nextRole == null) return;
    const role = nextRole.trim();
    if (!ROLE_OPTIONS.includes(role)) {
      await showAppAlert('대상자 직책 수정', '직책은 사원 (선임)/대리/과장/차장/부장/이사/팀장님 중에서 입력해주세요.');
      return;
    }
    const oldName = current.name;
    state.people[idx] = { ...current, name, role };
    state.people = sortPeopleByRoleAndName(state.people);
    // 분류 태그는 이름 문자열로 저장되므로 이름 변경 시 함께 치환
    state.assignments.outside = state.assignments.outside.map((n) => (n === oldName ? name : n));
    state.assignments.lunchbox = state.assignments.lunchbox.map((n) => (n === oldName ? name : n));
    state.cautions = state.cautions.map((c) => (c.name === oldName ? { ...c, name } : c));
    if (state.cautionStoreBlocks[oldName]) {
      state.cautionStoreBlocks[name] = [...state.cautionStoreBlocks[oldName]];
      delete state.cautionStoreBlocks[oldName];
    }
    if (state.assignmentPins[oldName]) {
      state.assignmentPins[name] = { ...state.assignmentPins[oldName] };
      delete state.assignmentPins[oldName];
    }
    savePeopleData();
    saveAssignments();
    saveCautions();
    renderPeopleAndAssignments();
    renderCautions();
  }

  function renderCautions() {
    const list = $('#caution-list');
    renderCautionPersonOptions();
    renderCautionStoreBlockSummary();
    if (!list) return;
    list.innerHTML = '';
    const hasBlocks = Object.keys(state.cautionStoreBlocks).length > 0;
    if (!state.cautions.length && !hasBlocks) {
      list.innerHTML = '<li style="border:none;background:transparent;color:#888;justify-content:center">등록된 입맛 보호 태그가 없습니다.</li>';
      return;
    }
    const grouped = new Map();
    state.cautions.forEach((c) => {
      if (!grouped.has(c.name)) grouped.set(c.name, []);
      grouped.get(c.name).push(c);
    });
    Object.keys(state.cautionStoreBlocks).forEach((name) => {
      if (!grouped.has(name)) grouped.set(name, []);
    });
    Array.from(grouped.entries()).forEach(([name, entries]) => {
      const li = document.createElement('li');
      const blockedKeys = Array.isArray(state.cautionStoreBlocks[name]) ? state.cautionStoreBlocks[name] : [];
      const blockedNames = blockedKeys.map((k) => getStoreLabelByBlockKey(k)).filter(Boolean);
      li.innerHTML = `
        <div>
          <div class="s-name">${escapeHtml(name)}</div>
          <div class="caution-tags">
            ${entries.map((c) => `<button class="caution-chip" data-action="delete" data-id="${escapeHtml(c.id)}" title="삭제">${escapeHtml(c.note)} ✕</button>`).join('')}
          </div>
          ${blockedNames.length ? `<div class="s-meta">못가는 가게: ${escapeHtml(blockedNames.join(', '))}</div>` : ''}
        </div>
        <div class="s-actions">
          <button class="caution-edit-btn" data-action="edit-blocks" data-name="${escapeHtml(name)}" title="못가는 가게 수정">✍️</button>
        </div>`;
      li.addEventListener('click', (e) => {
        const action = e.target.dataset && e.target.dataset.action;
        const targetId = e.target.dataset && e.target.dataset.id;
        const targetName = e.target.dataset && e.target.dataset.name;
        if (action === 'edit-blocks' && targetName) {
          openCautionStoreBlocksEditor(targetName).then((selected) => {
            if (!selected) return;
            if (selected.length) state.cautionStoreBlocks[targetName] = selected;
            else delete state.cautionStoreBlocks[targetName];
            saveCautions();
            renderCautions();
            renderPeopleAndAssignments();
          });
          return;
        }
        if (action !== 'delete' || !targetId) return;
        state.cautions = state.cautions.filter((x) => x.id !== targetId);
        saveCautions();
        renderPeopleAndAssignments();
        renderCautions();
      });
      list.appendChild(li);
    });
  }

  async function switchTab(tab) {
    cancelPickMode();
    state.activeTab = tab;
    updateTodayGroupTitle();
    $$('.meal-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));

    if (tab === 'settings') {
      $('#panel-meal').classList.add('hidden');
      $('#panel-settings').classList.remove('hidden');
      $$('input[name="reg-meal"]').forEach((r) => { r.checked = (r.value === state.meal); });
      renderSettingsStoreList();
      switchSettingsSubtab(state.settingsSubtab || 'people');
      return;
    }

    // meal tabs
    state.meal = tab;
    state.selectedStoreId = null;
    await Voting.load(state.meal);
    $('#panel-settings').classList.add('hidden');
    $('#panel-meal').classList.remove('hidden');

    renderStoreList();
    Maps.renderStores(getVisibleStores());
    renderRouletteFromShared();
    renderVote();
  }

  function bindTitleQuickSwitch() {
    const title = $('#app-title');
    if (!title) return;
    title.addEventListener('click', async () => {
      await switchTab(getInitialMealTabBySeoulTime());
    });
  }

  // ---------- 공통: URL로 가게 등록 ----------
  /**
   * URL(필수가 아님) + 이름(선택)으로 가게 등록.
   * statusCb(kind, msg): 'success' | 'warn' | 'error' | '' (info)
   * 반환: { store, warnNoCoords }
   */
  async function registerStoreSmart({ meal, url, manualName, memo, statusCb }) {
    const setStatus = (kind, msg) => { if (statusCb) statusCb(kind, msg); };

    let name = (manualName || '').trim() || null;
    let placeId = null;
    let lat = null, lng = null, address = null, phone = null, category = null;

    if (url) {
      setStatus('', '🔍 URL 분석 중…');
      const parsed = Maps.parseUrl(url);
      if (parsed) {
        if (!name && parsed.name) name = parsed.name;
        placeId = parsed.placeId;
        if (parsed.lat != null) { lat = parsed.lat; lng = parsed.lng; }
      }
    }

    if (!name && !placeId) {
      setStatus('error', '가게 이름이나 URL의 place ID를 찾을 수 없습니다.');
      return null;
    }

    if (placeId && window.AppConfig && window.AppConfig.placeLookup && window.NaverApi) {
      setStatus('', `🌐 네이버 지도에서 place ${placeId} 조회 중…`);
      try {
        const info = await NaverApi.getPlaceById(placeId);
        if (info) {
          if (info.name && !manualName) name = info.name;
          if (info.address) address = info.address;
          if (info.lat != null && info.lng != null) { lat = info.lat; lng = info.lng; }
          if (info.phone) phone = info.phone;
          if (info.category) category = info.category;
        }
      } catch (e) { console.warn('NaverApi lookup failed:', e); }
    }

    if ((lat == null || lng == null) && name) {
      setStatus('', `🔍 "${name}" 좌표 검색 중…`);
      const geo = await Maps.geocode(name);
      if (geo) { lat = geo.lat; lng = geo.lng; if (!address) address = geo.address; }
    }

    const warnNoCoords = (lat == null || lng == null);
    const finalName = name || (placeId ? `장소 ${placeId}` : '이름 없음');

    let store;
    try {
      store = await Stores.add(meal, {
        name: finalName,
        url: url || '',
        address: address || '',
        lat, lng,
        memo: (memo || '').trim(),
        placeId: placeId || null,
        phone: phone || null,
        category: category || null,
      });
    } catch (e) {
      setStatus('error', e && e.message ? e.message : '가게 등록 중 오류가 발생했습니다.');
      return null;
    }

    if (warnNoCoords) {
      setStatus('warn', `✓ "${finalName}" 등록됨. 좌표 자동 추출 실패 — 설정에서 "📍 지도에서 지정" 으로 위치를 잡아주세요.`);
    } else {
      setStatus('success', `✅ "${finalName}" 등록 완료. (${lat.toFixed(5)}, ${lng.toFixed(5)})`);
    }

    return { store, warnNoCoords };
  }

  // ---------- Settings: Auto-add (URL 폼) ----------
  function bindAutoAdd() {
    $('#btn-auto-add').addEventListener('click', async () => {
      const url = $('#reg-url').value.trim();
      const memo = $('#reg-memo').value.trim();
      const meal = ($$('input[name="reg-meal"]').find((r) => r.checked) || {}).value || 'lunch';
      const statusEl = $('#auto-add-status');

      const setStatus = (kind, msg) => {
        statusEl.className = 'auto-status ' + (kind || '');
        statusEl.textContent = msg;
      };

      if (!url) {
        setStatus('error', 'URL을 입력해주세요.');
        return;
      }

      const result = await registerStoreSmart({ meal, url, memo, statusCb: setStatus });
      if (!result) return;

      $('#reg-url').value = '';
      $('#reg-memo').value = '';
      state.meal = meal;
      $$('input[name="reg-meal"]').forEach((r) => { r.checked = (r.value === meal); });
      renderSettingsStoreList();
      // 현재 선택한 식사 탭이 활성이라면 지도/리스트도 즉시 갱신
      if (state.activeTab === meal) {
        renderStoreList();
        Maps.renderStores(getVisibleStores());
      }
      if (result.warnNoCoords) beginPickMode(result.store.id);
    });
  }

  function bindMapActions() {
    const moveBtn = $('#btn-map-my-location');
    if (!moveBtn) return;
    moveBtn.addEventListener('click', async () => {
      moveBtn.disabled = true;
      moveBtn.textContent = '🗺️ 지도 새로고침 중';
      try {
        await Maps.reload('map');
        Maps.renderStores(getVisibleStores());
        const loc = await Maps.moveToFixedLocation();
        if (!loc) return;
        const hint = $('#map-hint');
        if (hint) {
          hint.textContent = `📍 ${loc.name} (${loc.address}) 위치로 이동했습니다.`;
        }
      } finally {
        moveBtn.disabled = false;
        moveBtn.textContent = '📍 내 위치로 이동';
      }
    });
  }

  // ---------- Settings: Manual form ----------
  function bindStoreForm() {
    $('#store-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const meal = $$('input[name="reg-meal"]').find((r) => r.checked).value;
      const name = $('#store-name').value.trim();
      if (!name) return;

      let lat = $('#store-lat').value;
      let lng = $('#store-lng').value;
      const url = $('#store-url').value.trim();
      const address = $('#store-address').value.trim();

      if ((!lat || !lng) && url) {
        const parsed = Maps.parseUrl(url);
        if (parsed && parsed.lat != null) { lat = parsed.lat; lng = parsed.lng; }
      }
      if ((!lat || !lng) && address) {
        const r = await Maps.geocode(address);
        if (r) { lat = r.lat; lng = r.lng; }
      }

      try {
        await Stores.add(meal, {
          name, url, address,
          lat: lat || null,
          lng: lng || null,
          memo: $('#store-memo').value.trim(),
        });
      } catch (err) {
        await showAppAlert('가게 등록', err && err.message ? err.message : '가게 등록 중 오류가 발생했습니다.');
        return;
      }
      $('#store-form').reset();
      state.meal = meal;
      $$('input[name="reg-meal"]').forEach((r) => { r.checked = (r.value === meal); });
      renderSettingsStoreList();
    });

    $('#btn-geocode').addEventListener('click', async () => {
      const address = $('#store-address').value.trim();
      const url = $('#store-url').value.trim();
      let result = null;
      if (url) {
        const p = Maps.parseUrl(url);
        if (p && p.lat != null) result = { lat: p.lat, lng: p.lng };
      }
      if (!result && address) result = await Maps.geocode(address);
      if (result) {
        $('#store-lat').value = result.lat;
        $('#store-lng').value = result.lng;
      } else {
        await showAppAlert('좌표 찾기', '좌표를 찾지 못했습니다. 주소를 더 상세히 입력하거나, 위도/경도를 직접 입력해주세요.');
      }
    });
  }

  // ---------- Settings: Store list + pick mode ----------
  function renderSettingsStoreList() {
    const list = $('#settings-store-list');
    let stores = getVisibleStoresForMeal(state.meal, { includeMeta: true });
    const q = state.settingsStoreSearch || '';
    if (q) {
      stores = stores.filter((s) => String(s.name || '').toLowerCase().includes(q));
    }
    $('#settings-store-count').textContent = `(${stores.length})`;
    list.innerHTML = '';
    if (stores.length === 0) {
      list.innerHTML = '<li style="border:none;background:transparent;color:#888;justify-content:center">등록된 가게가 없습니다.</li>';
      return;
    }
    stores.forEach((s) => {
      const li = document.createElement('li');
      const sourceMeal = s.__sourceMeal || state.meal;
      const mirrored = Boolean(s.__isMirrored);
      const noCoords = (s.lat == null || s.lng == null);
      li.innerHTML = `
        <div>
          <div class="s-name">${escapeHtml(s.name)}
            ${noCoords ? '<span class="s-badge warn">좌표 미확인</span>' : ''}
            ${mirrored ? `<span class="s-badge">중복표시·원본:${mealLabel(sourceMeal)}</span>` : ''}
          </div>
          <div class="s-meta">
            ${buildStoreMetaHtml(s, true)}
          </div>
        </div>
        <div class="s-actions">
          ${s.url ? `<button data-action="open">🔗</button>` : ''}
          <button data-action="edit-memo">메모 수정</button>
          <button data-action="edit-visibility">중복 허용</button>
          ${mirrored ? '' : '<button data-action="edit-caution-tags">주의 태그</button>'}
          ${mirrored ? '' : '<button class="pick" data-action="pick">📍 지도에서 지정</button>'}
          <button class="delete" data-action="delete">삭제</button>
        </div>
      `;
      li.addEventListener('click', async (e) => {
        const action = e.target.dataset && e.target.dataset.action;
        if (action === 'delete') {
          const targetLabel = mirrored ? `${mealLabel(sourceMeal)}(원본)` : mealLabel(sourceMeal);
          if (await confirmAppDialog('가게 삭제', `"${s.name}" 삭제할까요?\n삭제 대상: ${targetLabel}`, { confirmText: '삭제' })) {
            await Stores.remove(sourceMeal, s.id);
            renderSettingsStoreList();
          }
          return;
        }
        if (action === 'open') { window.open(s.url, '_blank', 'noopener'); return; }
        if (action === 'edit-memo') {
          const edited = await promptAppDialog('가게 메모 수정', `"${s.name}" 메모를 수정하세요.`, s.memo || '');
          if (edited === null) return;
          await Stores.update(sourceMeal, s.id, { memo: edited });
          renderSettingsStoreList();
          if (MEAL_TYPES.includes(state.activeTab) && state.activeTab === state.meal) {
            renderStoreList();
            Maps.renderStores(getVisibleStores());
          }
          return;
        }
        if (action === 'edit-visibility') {
          await openDuplicateVisibilityMenu(s, sourceMeal);
          return;
        }
        if (action === 'edit-caution-tags') {
          await openStoreCautionTagsMenu(s, sourceMeal);
          return;
        }
        if (action === 'pick') { beginPickMode(s.id); return; }
      });
      list.appendChild(li);
    });
  }

  let settingsMap = null;
  let settingsMarkers = [];

  function ensureSettingsMap() {
    if (settingsMap || typeof naver === 'undefined') return;
    settingsMap = new naver.maps.Map('settings-map', {
      center: new naver.maps.LatLng(37.5666103, 126.9783882),
      zoom: 14,
    });
  }

  function renderSettingsMapMarkers(focusStore) {
    if (!settingsMap) return;
    settingsMarkers.forEach((m) => m.setMap(null));
    settingsMarkers = [];
    const stores = getVisibleStoresForMeal(state.meal, { includeMeta: false });
    const bounds = new naver.maps.LatLngBounds();
    let count = 0;
    stores.forEach((s) => {
      if (s.lat == null) return;
      const pos = new naver.maps.LatLng(s.lat, s.lng);
      const marker = new naver.maps.Marker({ position: pos, map: settingsMap, title: s.name });
      settingsMarkers.push(marker);
      bounds.extend(pos);
      count++;
    });
    if (focusStore && focusStore.lat != null) {
      settingsMap.setCenter(new naver.maps.LatLng(focusStore.lat, focusStore.lng));
      settingsMap.setZoom(16);
    } else if (count > 0) {
      settingsMap.fitBounds(bounds);
    }
  }

  function beginPickMode(storeId) {
    const store = Stores.getById(state.meal, storeId);
    if (!store) return;
    state.pickingForStoreId = storeId;
    $('#settings-map-wrap').classList.remove('hidden');
    $('#pick-mode-hint').textContent =
      `"${store.name}" 의 위치를 지도에서 클릭해주세요. (ESC로 취소)`;

    ensureSettingsMap();
    renderSettingsMapMarkers(store);

    if (typeof naver === 'undefined') return;
    // Use a dedicated click listener on the settings map.
    if (settingsMap._pickListener) {
      naver.maps.Event.removeListener(settingsMap._pickListener);
    }
    settingsMap.getElement().style.cursor = 'crosshair';
    settingsMap._pickListener = naver.maps.Event.addListener(settingsMap, 'click', async (e) => {
      const lat = e.coord.lat();
      const lng = e.coord.lng();
      const sid = state.pickingForStoreId;
      if (!sid) return;
      const stores = Stores.get(state.meal);
      const idx = stores.findIndex((x) => x.id === sid);
      if (idx >= 0) {
        stores[idx].lat = lat;
        stores[idx].lng = lng;
        await Storage.saveStores(state.meal, stores);
      }
      cancelPickMode();
      renderSettingsStoreList();
      renderSettingsMapMarkers(stores[idx]);
      // 잠시 후 패널 닫기
      setTimeout(() => $('#settings-map-wrap').classList.add('hidden'), 1500);
    });

    // 스크롤
    setTimeout(() => $('#settings-map-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
  }

  function cancelPickMode() {
    if (settingsMap) {
      if (settingsMap._pickListener) {
        naver.maps.Event.removeListener(settingsMap._pickListener);
        settingsMap._pickListener = null;
      }
      const el = settingsMap.getElement && settingsMap.getElement();
      if (el) el.style.cursor = '';
    }
    state.pickingForStoreId = null;
  }

  // ---------- Meal panel: Store list (read-only) ----------
  function renderStoreList() {
    const list = $('#store-list');
    let stores = getVisibleStores();
    const q = state.mainStoreSearch || '';
    if (q) {
      stores = stores.filter((s) => String(s.name || '').toLowerCase().includes(q));
    }
    $('#store-count').textContent = `(${stores.length})`;
    list.innerHTML = '';
    if (stores.length === 0) {
      list.innerHTML = '<li style="border:none;background:transparent;color:#888;justify-content:center">등록된 가게가 없습니다. 설정에서 추가해주세요.</li>';
      return;
    }
    stores.forEach((s) => {
      const li = document.createElement('li');
      li.dataset.id = s.id;
      if (state.selectedStoreId === s.id) li.classList.add('selected');
      const noCoords = (s.lat == null || s.lng == null);
      li.innerHTML = `
        <div>
          <div class="s-name">${escapeHtml(s.name)}
            ${noCoords ? '<span class="s-badge warn">좌표 미확인</span>' : ''}
          </div>
          <div class="s-meta">
            ${buildStoreMetaHtml(s, false)}
          </div>
        </div>
        <div class="s-actions">
          ${s.url ? `<button data-action="open">🔗</button>` : ''}
        </div>
      `;
      li.addEventListener('click', (e) => {
        const action = e.target.dataset && e.target.dataset.action;
        if (action === 'open') { window.open(s.url, '_blank', 'noopener'); return; }
        state.selectedStoreId = s.id;
        renderStoreList();
        Maps.focus(s);
      });
      list.appendChild(li);
    });
  }

  // ---------- Roulette ----------
  function bindRoulette() {
    $('#btn-pick-roulette').addEventListener('click', async () => {
      try {
        await maybeAutoResetRouletteForMeal(state.meal);
        if (isRouletteResultLocked(state.rouletteByMeal[state.meal])) {
          await showAppAlert('룰렛 이용 제한', ROULETTE_LOCK_MESSAGE);
          renderRouletteFromShared();
          return;
        }
        const picks = await pickRandomFromVisible(5);
        if (picks.length < 2) {
          await showAppAlert('룰렛 후보 부족', '이번 주(월~금) 제외 기록으로 인해 후보가 부족합니다. 설정 > 기록 관리에서 삭제하거나 가게를 추가해주세요.');
          return;
        }
        await saveRouletteForMeal(state.meal, buildRouletteSession(picks, 'random'));
        renderRouletteFromShared();
      } catch (e) {
        console.warn('roulette pick failed:', e);
        await showAppAlert('룰렛 후보 선정', '후보 선정 중 오류가 발생했습니다.');
      }
    });

    const selectedBtn = $('#btn-pick-roulette-selected');
    if (selectedBtn) {
      selectedBtn.addEventListener('click', async () => {
        await maybeAutoResetRouletteForMeal(state.meal);
        if (isRouletteResultLocked(state.rouletteByMeal[state.meal])) {
          await showAppAlert('룰렛 이용 제한', ROULETTE_LOCK_MESSAGE);
          renderRouletteFromShared();
          return;
        }
        const selected = await openStorePickerModal({
          title: '선택 룰렛',
          subtitle: '룰렛에 넣을 가게를 선택하세요. (최소 2개, 최대 10개)',
          saveLabel: '룰렛 준비',
          minSelect: 2,
          maxSelect: 10,
          filterFn: (s) => !isBlockedByCaution(s),
        });
        if (!selected || !selected.length) return;
        await saveRouletteForMeal(state.meal, buildRouletteSession(selected, 'selected'));
        renderRouletteFromShared();
      });
    }

    $('#btn-spin').addEventListener('click', async () => {
      await maybeAutoResetRouletteForMeal(state.meal);
      const current = state.rouletteByMeal[state.meal];
      if (isRouletteResultLocked(current)) {
        await showAppAlert('룰렛 이용 제한', ROULETTE_LOCK_MESSAGE);
        renderRouletteFromShared();
        return;
      }
      const items = current && Array.isArray(current.items) ? current.items : [];
      if (items.length < 2) {
        await showAppAlert('룰렛 돌리기', '먼저 룰렛 후보를 준비해주세요.');
        return;
      }
      const winner = items[Math.floor(Math.random() * items.length)];
      const spinId = `rspin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const next = {
        ...current,
        id: spinId,
        status: 'spinning',
        winnerId: winner.id,
        winnerName: winner.name,
        spunAt: Date.now(),
        startAt: Date.now() + getRouletteSpinLeadMs(),
        durationMs: getRouletteSpinDurationMs(),
        spinTurns: getRouletteSpinTurns(),
        startRotation: 0,
        updatedAt: Date.now(),
      };
      $('#btn-spin').disabled = true;
      $('#roulette-result').textContent = '룰렛이 곧 시작됩니다…';
      $('#roulette-result').classList.remove('winner');
      await saveRouletteForMeal(state.meal, next);
      await appendRandomWinnerHistory(state.meal, winner, 'rouletteWinner', `roulette:${spinId}`);
      renderRouletteFromShared();
      schedulePoll();
    });

    const resetBtn = $('#btn-reset-roulette');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        const session = state.rouletteByMeal[state.meal];
        if (!session || !Array.isArray(session.items) || !session.items.length) {
          await showAppAlert('룰렛 초기화', '초기화할 룰렛 결과가 없습니다.');
          return;
        }
        if (!(await verifyAdminPassword(
          '룰렛 초기화',
          '관리자가 지정한 암호로만 룰렛 결과를 초기화할 수 있습니다.'
        ))) return;
        if (!(await confirmAppDialog(
          '🧺 룰렛 초기화',
          '룰렛 후보와 결과를 초기화할까요?',
          { confirmText: '초기화', className: 'vote-delete-confirm-modal' }
        ))) return;
        await saveRouletteForMeal(state.meal, null);
        state.rouletteRenderedSessionId = '';
        renderRouletteFromShared();
      });
    }
  }

  function buildRouletteSession(items, mode) {
    const unique = dedupeStoresByUrl(items);
    return {
      id: `rset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      meal: state.meal,
      mode: mode || 'random',
      status: 'ready',
      items: unique.map((it) => ({ id: it.id, name: it.name })),
      winnerId: '',
      winnerName: '',
      startAt: 0,
      durationMs: getRouletteSpinDurationMs(),
      spinTurns: 0,
      startRotation: 0,
      updatedAt: Date.now(),
    };
  }

  function isRouletteSpinning(meal) {
    const session = state.rouletteByMeal[meal];
    if (!session || session.status !== 'spinning') return false;
    const startAt = Number(session.startAt || 0);
    const duration = Number(session.durationMs || getRouletteSpinDurationMs());
    if (!startAt) return false;
    return Date.now() < (startAt + duration + 200);
  }

  async function loadRouletteForMeal(meal) {
    if (!window.Storage || typeof window.Storage.getRoulette !== 'function') {
      state.rouletteByMeal[meal] = null;
      return null;
    }
    try {
      state.rouletteByMeal[meal] = await window.Storage.getRoulette(meal);
      await maybeAutoResetRouletteForMeal(meal);
    } catch (e) {
      console.warn('getRoulette failed:', e);
      state.rouletteByMeal[meal] = null;
    }
    return state.rouletteByMeal[meal];
  }

  async function saveRouletteForMeal(meal, session) {
    state.rouletteByMeal[meal] = session || null;
    if (!window.Storage || typeof window.Storage.saveRoulette !== 'function') return;
    if (session) {
      await window.Storage.saveRoulette(meal, session);
    } else if (typeof window.Storage.clearRoulette === 'function') {
      await window.Storage.clearRoulette(meal);
    } else {
      await window.Storage.saveRoulette(meal, null);
    }
  }

  function renderRouletteFromShared() {
    const resultEl = $('#roulette-result');
    const spinBtn = $('#btn-spin');
    if (!resultEl || !spinBtn) return;
    const session = state.rouletteByMeal[state.meal];
    if (!session || !Array.isArray(session.items) || session.items.length < 2) {
      Roulette.setItems([]);
      setRouletteSetupButtonsDisabled(false);
      resultEl.textContent = '';
      resultEl.classList.remove('winner');
      spinBtn.disabled = true;
      state.rouletteRenderedSessionId = '';
      return;
    }
    const itemSignature = Roulette.getItemsSignature(session.items);
    const currentSignature = Roulette.getItemsSignature();
    const itemsChanged = itemSignature !== currentSignature;
    if (session.status === 'spinning' && session.winnerId) {
      setRouletteSetupButtonsDisabled(true);
      if (itemsChanged) Roulette.setItems(session.items);
      const startAt = Number(session.startAt || 0);
      const duration = Number(session.durationMs || getRouletteSpinDurationMs());
      const endAt = startAt + duration;
      const sessionId = String(session.id || `${session.winnerId}:${startAt}:${duration}`);
      const playKey = `playing:${sessionId}`;
      const settledKey = `settled:${sessionId}`;
      spinBtn.disabled = true;
      if (Date.now() >= endAt) {
        const winner = Roulette.settle(session);
        showRouletteWinner(winner || Roulette.resolveWinner(session), session);
        spinBtn.disabled = isRouletteResultLocked(session);
        state.rouletteRenderedSessionId = settledKey;
        return;
      }
      resultEl.textContent = Date.now() < startAt ? '룰렛이 곧 시작됩니다…' : '룰렛이 돌아가고 있습니다…';
      resultEl.classList.remove('winner');
      if (state.rouletteRenderedSessionId !== playKey || !Roulette.spinning || itemsChanged) {
        state.rouletteRenderedSessionId = playKey;
        Roulette.play(session, (winner) => {
          showRouletteWinner(winner || Roulette.resolveWinner(session), session);
          spinBtn.disabled = isRouletteResultLocked(session);
          state.rouletteRenderedSessionId = settledKey;
          schedulePoll();
        });
      }
      return;
    }
    setRouletteSetupButtonsDisabled(false);
    Roulette.setItems(session.items);
    resultEl.classList.remove('winner');
    resultEl.textContent = session.mode === 'selected'
      ? `선택 룰렛 후보 ${session.items.length}곳을 준비했습니다.`
      : `후보 ${session.items.length}곳을 무작위로 선정했습니다.`;
    spinBtn.disabled = false;
    state.rouletteRenderedSessionId = '';
  }

  function showRouletteWinner(winner, session) {
    const resultEl = $('#roulette-result');
    const winnerName = (winner && winner.name) || Roulette.getDisplayWinner(session);
    if (resultEl) {
      resultEl.textContent = `🎉 오늘은 "${winnerName}" 입니다!`;
      resultEl.classList.add('winner');
    }
    return winnerName;
  }

  function getRouletteSpinLeadMs() {
    return getPositiveConfigNumber('rouletteSpinLeadMs', ROULETTE_DEFAULT_LEAD_MS);
  }

  function getRouletteSpinDurationMs() {
    return getPositiveConfigNumber('rouletteSpinDurationMs', ROULETTE_DEFAULT_DURATION_MS);
  }

  function getRouletteSpinTurns() {
    return 5 + Math.floor(Math.random() * 3);
  }

  function getPositiveConfigNumber(key, fallback) {
    const value = Number(window.AppConfig && window.AppConfig[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function setRouletteSetupButtonsDisabled(disabled) {
    const pickBtn = $('#btn-pick-roulette');
    const selectedBtn = $('#btn-pick-roulette-selected');
    if (pickBtn) pickBtn.disabled = Boolean(disabled);
    if (selectedBtn) selectedBtn.disabled = Boolean(disabled);
  }

  function isRouletteResultLocked(session) {
    if (!session || !session.winnerId) return false;
    const resetAt = getRouletteAutoResetAtMs(session);
    return !resetAt || Date.now() < resetAt;
  }

  function shouldAutoResetRoulette(session) {
    if (!session || !session.winnerId) return false;
    const resetAt = getRouletteAutoResetAtMs(session);
    return Boolean(resetAt && Date.now() >= resetAt);
  }

  async function maybeAutoResetRouletteForMeal(meal) {
    const session = state.rouletteByMeal[meal];
    if (!shouldAutoResetRoulette(session)) return false;
    await saveRouletteForMeal(meal, null);
    if (meal === state.meal) state.rouletteRenderedSessionId = '';
    return true;
  }

  function getRouletteAutoResetAtMs(session) {
    const baseTs = Number(session && (session.spunAt || session.startAt || session.updatedAt) || 0);
    if (!baseTs) return 0;
    const { year, month, day } = getSeoulDateParts(baseTs);
    return Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0);
  }

  function getSeoulDateParts(ts) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ts));
    return {
      year: Number(parts.find((p) => p.type === 'year')?.value || 0),
      month: Number(parts.find((p) => p.type === 'month')?.value || 1),
      day: Number(parts.find((p) => p.type === 'day')?.value || 1),
    };
  }

  function startRouletteAutoResetWatcher() {
    let running = false;
    setInterval(async () => {
      if (running) return;
      running = true;
      try {
        let resetDone = false;
        for (const meal of MEAL_TYPES) {
          resetDone = (await maybeAutoResetRouletteForMeal(meal)) || resetDone;
        }
        if (resetDone && MEAL_TYPES.includes(state.activeTab)) {
          renderRouletteFromShared();
        }
      } catch (e) {
        console.warn('roulette auto reset watcher failed:', e);
      } finally {
        running = false;
      }
    }, 60 * 1000);
  }


  // ---------- Voting ----------
  function bindVoting() {
    const now = new Date();
    const later = new Date(now.getTime() + 30 * 60 * 1000);
    $('#vote-start').value = toLocalDtInput(now);
    $('#vote-end').value = toLocalDtInput(later);

    $('#btn-pick-vote').addEventListener('click', async () => {
      const count = Math.max(2, Math.min(15, parseInt($('#vote-candidate-count').value, 10) || 5));
      try {
        const picks = await pickRandomFromVisible(count);
        if (picks.length < 2) {
          await showAppAlert('투표 후보 부족', '이번 주(월~금) 제외 기록으로 인해 후보가 부족합니다. 설정 > 기록 관리에서 삭제하거나 가게를 추가해주세요.');
          return;
        }
        renderVotePreview(picks);
      } catch (e) {
        console.warn('vote candidate pick failed:', e);
        await showAppAlert('투표 후보 선정', '후보 선정 중 오류가 발생했습니다.');
      }
    });

    const voteSelectedBtn = $('#btn-pick-vote-selected');
    if (voteSelectedBtn) {
      voteSelectedBtn.addEventListener('click', async () => {
        const selected = await openStorePickerModal({
          title: '후보 선택 투표',
          subtitle: '투표 후보로 넣을 가게를 선택하세요. (최소 2개, 최대 15개)',
          saveLabel: '후보 확정',
          minSelect: 2,
          maxSelect: 15,
          filterFn: (s) => !isBlockedByCaution(s),
        });
        if (!selected || !selected.length) return;
        renderVotePreview(selected);
      });
    }

    $('#btn-create-vote').addEventListener('click', async () => {
      if ($('#btn-create-vote').disabled) return;
      const startAt = new Date($('#vote-start').value).getTime();
      const endAt = new Date($('#vote-end').value).getTime();
      const candidates = window.__pendingVoteCandidates;
      const voters = state.people.map((p) => p.name);
      if (!candidates || candidates.length < 2) {
        await showAppAlert('투표 생성', '먼저 "후보 무작위 선정" 또는 "후보 선택 투표"로 후보를 준비해주세요.');
        return;
      }
      if (!voters.length) {
        await showAppAlert('투표 생성', '투표 대상자(위대한 명단)가 없습니다. 설정에서 대상자를 먼저 추가해주세요.');
        return;
      }
      try {
        const vote = await Voting.create(state.meal, candidates, startAt, endAt, voters);
        window.__pendingVoteCandidates = null;
        setVoteCreateEnabled(false);
        Voting.current[state.meal] = vote;
        renderVote();
      } catch (e) { await showAppAlert('투표 생성', e.message || '투표 생성 중 오류가 발생했습니다.'); }
    });

    $('#btn-cancel-vote').addEventListener('click', async () => {
      if (!(await verifyVoteDeletePassword())) return;
      if (!(await confirmAppDialog(
        '🧺 투표 종료/삭제',
        '현재 투표를 종료/삭제할까요?',
        { confirmText: '정리하기', className: 'vote-delete-confirm-modal' }
      ))) return;
      await Voting.clear(state.meal);
      renderVote();
    });

    const historyBtn = $('#btn-vote-history');
    if (historyBtn) {
      historyBtn.addEventListener('click', async () => {
        await Voting.loadHistory(state.meal);
        openVoteHistoryModal(state.meal);
      });
    }
  }

  function renderVotePreview(picks) {
    const unique = dedupeStoresByUrl(picks);
    window.__pendingVoteCandidates = unique.map((s) => ({ id: s.id, name: s.name }));
    setVoteCreateEnabled(true);
    const ul = $('#vote-candidates');
    ul.innerHTML = '';
    unique.forEach((c) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(c.name)}</span><span class="muted">대기 중</span>`;
      ul.appendChild(li);
    });
    $('#vote-active').classList.remove('hidden');
    $('#vote-status-label').textContent = '🟡 후보 선정됨 — 시작/종료 시간 확인 후 [투표 생성]을 눌러주세요.';
    $('#vote-timer').textContent = '';
    $('#vote-results').innerHTML = '';
  }

  function renderVote() {
    clearVoteTimer();
    const vote = Voting.get(state.meal);
    const setup = document.querySelector('.vote-setup');
    if (!vote) {
      if (window.__pendingVoteCandidates && window.__pendingVoteCandidates.length >= 2) {
        setVoteCreateEnabled(true);
        if (setup) setup.classList.remove('hidden');
        return;
      }
      setVoteCreateEnabled(false);
      $('#vote-active').classList.add('hidden');
      if (setup) setup.classList.remove('hidden');
      return;
    }
    setVoteCreateEnabled(false);
    if (setup) setup.classList.add('hidden');
    $('#vote-active').classList.remove('hidden');

    const status = Voting.status(vote);
    if (status === 'ended') {
      ensureVoteWinnerRecorded(vote).catch((e) => console.warn('ensureVoteWinnerRecorded failed:', e));
    }
    const statusLabel = {
      pending: '🟡 투표 대기 중 (아직 시작 전)',
      open:    '🟢 투표 진행 중',
      ended:   '🔴 투표 종료',
    }[status];
    $('#vote-status-label').textContent = statusLabel;
    $('#vote-timer').textContent = formatVoteRange(vote);

    const votedSet = new Set(
      Array.isArray(vote.votedPeople)
        ? vote.votedPeople
        : Object.values(vote.votes || {}).flatMap((list) => Array.isArray(list) ? list : [])
    );
    const allowedVoters = Array.isArray(vote.voters) && vote.voters.length
      ? vote.voters
      : state.people.map((p) => p.name);
    const remainingVoters = allowedVoters.filter((name) => !votedSet.has(name));
    renderVoteVoterSelect(remainingVoters);
    const hintEl = $('#vote-voter-hint');
    if (hintEl) {
      hintEl.textContent = remainingVoters.length
        ? `남은 투표 가능 대상자: ${remainingVoters.length}명`
        : '모든 대상자의 투표가 완료되었습니다.';
    }

    const ul = $('#vote-candidates');
    ul.innerHTML = '';
    vote.candidates.forEach((c) => {
      const li = document.createElement('li');
      const count = (vote.votes[c.id] || []).length;
      const disabled = status !== 'open' || !remainingVoters.length;
      li.innerHTML = `
        <span>${escapeHtml(c.name)} <span class="muted">· ${count}표</span></span>
        <button data-cid="${c.id}" ${disabled ? 'disabled' : ''}>${disabled ? '투표 불가' : '투표하기'}</button>
      `;
      li.querySelector('button').addEventListener('click', async () => {
        const voterSelect = $('#vote-voter-select');
        const name = voterSelect ? String(voterSelect.value || '').trim() : '';
        if (!name) {
          await showAppAlert('투표하기', '투표 대상자를 먼저 선택해주세요.');
          if (voterSelect) voterSelect.focus();
          return;
        }
        try {
          await Voting.cast(state.meal, c.id, name);
          renderVote();
        } catch (e) { await showAppAlert('투표하기', e.message || '투표 중 오류가 발생했습니다.'); }
      });
      ul.appendChild(li);
    });

    const res = $('#vote-results');
    res.innerHTML = '';
    const totalVotes = Object.values(vote.votes).reduce((a, list) => a + list.length, 0);
    const sorted = [...vote.candidates].sort(
      (a, b) => (vote.votes[b.id] || []).length - (vote.votes[a.id] || []).length
    );
    sorted.forEach((c) => {
      const voters = vote.votes[c.id] || [];
      const pct = totalVotes ? Math.round((voters.length / totalVotes) * 100) : 0;
      const li = document.createElement('li');
      li.innerHTML = `
        <span><strong>${escapeHtml(c.name)}</strong></span>
        <span class="muted">${voters.length}표 (${pct}%)</span>
        <div class="bar"><div style="width:${pct}%"></div></div>
        ${voters.length ? `<div class="vote-role-summary">${escapeHtml(formatVoteRoleSummary(voters))}</div>` : ''}
      `;
      res.appendChild(li);
    });

    if (status !== 'ended') {
      state.voteTimer = setInterval(() => {
        $('#vote-timer').textContent = formatVoteRange(vote);
        const newStatus = Voting.status(vote);
        if (newStatus !== status) renderVote();
      }, 1000);
    }
  }

  function renderVoteVoterSelect(remainingVoters) {
    const select = $('#vote-voter-select');
    if (!select) return;
    const prev = select.value;
    select.innerHTML = '<option value="">대상자를 선택하세요</option>';
    remainingVoters.forEach((name) => {
      const op = document.createElement('option');
      op.value = name;
      op.textContent = formatPersonLabel(name);
      select.appendChild(op);
    });
    if (remainingVoters.includes(prev)) {
      select.value = prev;
    } else {
      select.value = '';
    }
  }

  function setVoteCreateEnabled(enabled) {
    const btn = $('#btn-create-vote');
    if (!btn) return;
    btn.disabled = !enabled;
    btn.title = enabled ? '' : '후보 무작위 선정 또는 후보 선택 투표를 먼저 진행하세요.';
  }

  function formatVoteRoleSummary(voters) {
    const names = Array.isArray(voters) ? voters : [];
    if (!names.length) return '';
    const counts = new Map();
    names.forEach((name) => {
      const role = getPersonRoleByName(name) || '직책 미지정';
      counts.set(role, (counts.get(role) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort(([a], [b]) => getRoleSortIndex(a) - getRoleSortIndex(b) || a.localeCompare(b, 'ko'))
      .map(([role, count]) => `${role} ${count}명`)
      .join(' · ');
  }

  function getPersonRoleByName(name) {
    const matched = state.people.find((p) => p.name === name);
    return matched && matched.role ? matched.role : '';
  }

  function getRoleSortIndex(role) {
    const idx = ROLE_OPTIONS.indexOf(role);
    return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
  }

  function openVoteHistoryModal(meal) {
    const rows = [...Voting.getHistory(meal)]
      .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
    const backdrop = document.createElement('div');
    backdrop.className = 'visibility-modal-backdrop';
    const mealName = mealLabel(meal);
    const itemsHtml = rows.length
      ? rows.map((row) => {
        const when = formatSeoulDateTime(row.endAt || row.createdAt || row.archivedAt);
        const winnerText = formatWinnerText(row);
        return `
          <li>
            <div class="vote-history-title">${escapeHtml(when)} · ${escapeHtml(mealName)}</div>
            <div><strong>결과:</strong> ${escapeHtml(winnerText)}</div>
            <div class="vote-history-meta">${escapeHtml(formatScoreText(row))}</div>
          </li>
        `;
      }).join('')
      : '<li><div class="vote-history-meta">기록된 이전 투표가 없습니다.</div></li>';
    backdrop.innerHTML = `
      <div class="visibility-modal vote-history-modal" role="dialog" aria-modal="true">
        <div class="vote-history-modal-head">
          <h3 class="vote-history-modal-title">🕘 이전 투표 기록</h3>
          <button type="button" class="btn btn-link vote-history-delete-btn" data-action="clear-history" ${rows.length ? '' : 'disabled'}>기록 삭제</button>
        </div>
        <p class="muted">${escapeHtml(mealName)} 탭의 과거 최종 결과입니다.</p>
        <ul class="vote-history-list">${itemsHtml}</ul>
        <div class="actions">
          <button type="button" data-action="close">닫기</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    const closeBtn = backdrop.querySelector('[data-action="close"]');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const clearBtn = backdrop.querySelector('[data-action="clear-history"]');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (!rows.length) {
          await showAppAlert('이전 투표 기록', '삭제할 이전 투표 기록이 없습니다.');
          return;
        }
        if (!(await verifyVoteHistoryDeletePassword())) return;
        if (!(await confirmAppDialog(
          '이전 투표 기록 삭제',
          `${mealName} 탭의 이전 투표 기록을 모두 삭제할까요?`,
          { confirmText: '삭제' }
        ))) return;
        try {
          await Voting.clearHistory(meal);
          close();
          openVoteHistoryModal(meal);
        } catch (e) {
          console.warn('clear vote history failed:', e);
          await showAppAlert('이전 투표 기록 삭제', e.message || '기록 삭제에 실패했습니다.');
        }
      });
    }
  }

  function formatWinnerText(row) {
    const winners = Array.isArray(row && row.winners) ? row.winners : [];
    if (!winners.length) return '무효(득표 없음)';
    if (winners.length === 1) {
      return `${winners[0].name} (${winners[0].count}표)`;
    }
    return `공동 1위: ${winners.map((w) => `${w.name}(${w.count}표)`).join(', ')}`;
  }

  function formatScoreText(row) {
    const scores = Array.isArray(row && row.scores) ? row.scores : [];
    if (!scores.length) return '후보 정보 없음';
    return scores.map((s) => `${s.name} ${s.count}표`).join(' · ');
  }

  function formatSeoulDateTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const date = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
    return date.replace(/\.\s*$/, '');
  }

  async function loadRandomHistoryForMeal(meal) {
    if (!window.Storage || typeof window.Storage.getRandomHistory !== 'function') {
      state.randomHistoryByMeal[meal] = [];
      return [];
    }
    try {
      const rows = await window.Storage.getRandomHistory(meal);
      let list = Array.isArray(rows) ? rows : [];
      if (window.WeekHistory) {
        list = window.WeekHistory.filterActiveRecords(list);
      }
      state.randomHistoryByMeal[meal] = list
        .filter((r) => r && r.storeId && r.createdAt)
        .map((r) => ({
          id: String(r.id || uid('rh')),
          storeId: String(r.storeId),
          storeName: String(r.storeName || ''),
          source: String(r.source || 'unknown'),
          sourceRef: String(r.sourceRef || ''),
          createdAt: Number(r.createdAt || 0),
          meal: meal,
        }));
    } catch (e) {
      console.warn('getRandomHistory failed:', e);
      state.randomHistoryByMeal[meal] = [];
    }
    return state.randomHistoryByMeal[meal];
  }

  function getRecentRandomBlockedIds(meal) {
    const rows = Array.isArray(state.randomHistoryByMeal[meal]) ? state.randomHistoryByMeal[meal] : [];
    return new Set(
      rows
        .filter((r) => r.source === 'rouletteWinner' || r.source === 'voteWinner')
        .map((r) => r.storeId)
    );
  }

  async function appendRandomWinnerHistory(meal, store, source, sourceRef) {
    if (!window.Storage || typeof window.Storage.saveRandomHistory !== 'function') return;
    if (window.WeekHistory && !window.WeekHistory.isWorkdayForRecording()) return;
    if (!store || !store.id) return;
    const ref = String(sourceRef || '');
    if (ref) {
      const existing = Array.isArray(state.randomHistoryByMeal[meal]) ? state.randomHistoryByMeal[meal] : [];
      if (existing.some((r) => r.sourceRef === ref)) return;
    }
    const rec = {
      id: uid('rh'),
      storeId: store.id,
      storeName: store.name || '',
      source: source || 'unknown',
      sourceRef: ref,
      createdAt: Date.now(),
    };
    await window.Storage.saveRandomHistory(meal, rec);
    await loadRandomHistoryForMeal(meal);
    if (state.settingsSubtab === 'history') renderRandomHistoryManager();
  }

  async function ensureVoteWinnerRecorded(vote) {
    if (!vote || !vote.id) return;
    const winner = getVoteFinalWinner(vote);
    if (!winner) return;
    await appendRandomWinnerHistory(
      vote.meal || state.meal,
      { id: winner.id, name: winner.name },
      'voteWinner',
      `vote:${vote.id}`
    );
  }

  function getVoteFinalWinner(vote) {
    const candidates = Array.isArray(vote.candidates) ? vote.candidates : [];
    if (!candidates.length) return null;
    let best = null;
    candidates.forEach((c, idx) => {
      const count = Array.isArray(vote.votes && vote.votes[c.id]) ? vote.votes[c.id].length : 0;
      if (!best || count > best.count || (count === best.count && idx < best.idx)) {
        best = { id: c.id, name: c.name, count, idx };
      }
    });
    if (!best || best.count <= 0) return null;
    return best;
  }

  function bindRandomHistoryManager() {
    const mealFilter = $('#random-history-meal');
    if (mealFilter) {
      mealFilter.addEventListener('change', () => {
        renderRandomHistoryManager();
      });
    }
    const clearAllBtn = $('#btn-random-history-clear-all');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', async () => {
        if (!(await verifyHistoryAdminPassword('랜덤 / 후보 기록 전체 기록 삭제'))) return;
        const targetMeal = (mealFilter && mealFilter.value) || 'all';
        const meals = targetMeal === 'all' ? MEAL_TYPES : [targetMeal];
        const targetLabel = targetMeal === 'all' ? '전체 식사 탭' : mealLabel(targetMeal);
        if (!(await confirmAppDialog(
          '랜덤 / 후보 기록 전체 기록 삭제',
          `${targetLabel} 기록을 모두 삭제할까요?`,
          { confirmText: '전체 삭제', className: 'history-clear-confirm-modal' }
        ))) return;
        for (const meal of meals) {
          if (window.Storage && typeof window.Storage.clearRandomHistory === 'function') {
            await window.Storage.clearRandomHistory(meal);
          }
          state.randomHistoryByMeal[meal] = [];
        }
        renderRandomHistoryManager();
      });
    }
  }

  function renderRandomHistoryManager() {
    const list = $('#random-history-list');
    if (!list) return;
    const mealFilter = ($('#random-history-meal') && $('#random-history-meal').value) || 'all';
    const meals = mealFilter === 'all' ? MEAL_TYPES : [mealFilter];
    const rows = meals
      .flatMap((meal) => (state.randomHistoryByMeal[meal] || []).map((r) => ({ ...r, meal })))
      .sort((a, b) => b.createdAt - a.createdAt);
    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML = '<li style="border:none;background:transparent;color:#888;justify-content:center">기록이 없습니다.</li>';
      return;
    }
    rows.forEach((row) => {
      const li = document.createElement('li');
      const sourceText = ({
        rouletteWinner: '랜덤 룰렛 당첨',
        voteWinner: '투표 최종 당첨',
        voteCandidate: '투표 후보 선정(구기록)',
        roulette: '랜덤 후보 선정(구기록)',
      }[row.source] || row.source || '기록');
      const resetAt = window.WeekHistory
        ? formatSeoulDateTime(window.WeekHistory.getNextSaturday10Ms())
        : '-';
      li.innerHTML = `
        <div>
          <div class="s-name">${escapeHtml(row.storeName || row.storeId)}</div>
          <div class="s-meta">${escapeHtml(mealLabel(row.meal))} · ${escapeHtml(sourceText)} · ${escapeHtml(formatSeoulDateTime(row.createdAt))} (초기화: 토요일 10:00 · ${escapeHtml(resetAt)})</div>
        </div>
        <div class="s-actions"><button data-action="delete" data-meal="${escapeHtml(row.meal)}" data-id="${escapeHtml(row.id)}">삭제</button></div>
      `;
      li.addEventListener('click', async (e) => {
        const action = e.target.dataset && e.target.dataset.action;
        const rid = e.target.dataset && e.target.dataset.id;
        const meal = e.target.dataset && e.target.dataset.meal;
        if (action !== 'delete' || !rid || !meal) return;
        if (!(await verifyHistoryAdminPassword())) return;
        if (!(await confirmAppDialog(
          '랜덤 / 후보 기록 삭제',
          '해당 기록을 삭제할까요?',
          { confirmText: '삭제' }
        ))) return;
        if (window.Storage && typeof window.Storage.deleteRandomHistory === 'function') {
          await window.Storage.deleteRandomHistory(meal, rid);
        }
        await loadRandomHistoryForMeal(meal);
        renderRandomHistoryManager();
      });
      list.appendChild(li);
    });
  }

  function verifyHistoryAdminPassword(title = '랜덤 / 후보 기록 삭제') {
    return verifyAdminPassword(
      title,
      '관리자가 지정한 암호로만 기록을 삭제할 수 있습니다.'
    );
  }

  function verifyAdminPassword(title, message) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'visibility-modal-backdrop';
      const isSoftDelete = title === '투표 종료/삭제' || title === '룰렛 초기화';
      const modalClass = isSoftDelete
        ? 'visibility-modal vote-delete-confirm-modal'
        : 'visibility-modal';
      backdrop.innerHTML = `
        <div class="${modalClass}" role="dialog" aria-modal="true">
          <h3>${escapeHtml(isSoftDelete ? `🧺 ${title}` : (title || '관리자 확인'))}</h3>
          <p class="muted">${escapeHtml(message || '관리자 암호를 입력하세요.')}</p>
          <label style="display:flex;flex-direction:column;gap:6px;margin:10px 0 14px;font-size:13px;color:var(--muted)">
            암호 입력
            <input type="password" id="admin-password-input" autocomplete="off" placeholder="암호를 입력하세요" />
          </label>
          <div class="admin-password-error hidden" role="alert"></div>
          <div class="actions">
            <button type="button" data-action="cancel">취소</button>
            <button type="button" data-action="confirm">확인</button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);
      const close = (ok) => {
        backdrop.remove();
        resolve(ok);
      };
      const input = backdrop.querySelector('#admin-password-input');
      const error = backdrop.querySelector('.admin-password-error');
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(false);
      });
      backdrop.querySelector('[data-action="cancel"]').addEventListener('click', () => close(false));
      const submit = () => {
        const value = input ? String(input.value || '') : '';
        if (value !== HISTORY_ADMIN_PASSWORD) {
          if (error) {
            error.textContent = '비밀번호가 올바르지 않습니다.';
            error.classList.remove('hidden');
          }
          if (input) input.focus();
          return;
        }
        close(true);
      };
      backdrop.querySelector('[data-action="confirm"]').addEventListener('click', submit);
      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submit();
        });
        setTimeout(() => input.focus(), 0);
      }
    });
  }

  function showAppAlert(title, message, options = {}) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'visibility-modal-backdrop';
      const modalClass = ['visibility-modal', 'app-message-modal', options.className || '']
        .filter(Boolean)
        .join(' ');
      const confirmText = options.confirmText || '확인';
      backdrop.innerHTML = `
        <div class="${modalClass}" role="alertdialog" aria-modal="true">
          <h3>${escapeHtml(title || '알림')}</h3>
          <p class="muted dialog-message">${escapeHtml(message || '')}</p>
          <div class="actions">
            <button type="button" data-action="confirm">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);
      const close = () => {
        backdrop.remove();
        resolve(true);
      };
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
      });
      const btn = backdrop.querySelector('[data-action="confirm"]');
      btn.addEventListener('click', close);
      setTimeout(() => btn.focus(), 0);
    });
  }

  function confirmAppDialog(title, message, options = {}) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'visibility-modal-backdrop';
      const modalClass = ['visibility-modal', options.className || '']
        .filter(Boolean)
        .join(' ');
      const confirmText = options.confirmText || '확인';
      const cancelText = options.cancelText || '취소';
      backdrop.innerHTML = `
        <div class="${modalClass}" role="dialog" aria-modal="true">
          <h3>${escapeHtml(title || '확인')}</h3>
          <p class="muted dialog-message">${escapeHtml(message || '진행할까요?')}</p>
          <div class="actions">
            <button type="button" data-action="cancel">${escapeHtml(cancelText)}</button>
            <button type="button" data-action="confirm">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);
      const close = (ok) => {
        backdrop.remove();
        resolve(ok);
      };
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(false);
      });
      backdrop.querySelector('[data-action="cancel"]').addEventListener('click', () => close(false));
      backdrop.querySelector('[data-action="confirm"]').addEventListener('click', () => close(true));
    });
  }

  function promptAppDialog(title, message, defaultValue = '', options = {}) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'visibility-modal-backdrop';
      const modalClass = ['visibility-modal', 'app-message-modal', options.className || '']
        .filter(Boolean)
        .join(' ');
      const confirmText = options.confirmText || '확인';
      const cancelText = options.cancelText || '취소';
      const inputId = `dialog-input-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      backdrop.innerHTML = `
        <div class="${modalClass}" role="dialog" aria-modal="true">
          <h3>${escapeHtml(title || '입력')}</h3>
          <label class="dialog-input-label" for="${escapeHtml(inputId)}">
            <span>${escapeHtml(message || '값을 입력하세요.')}</span>
            <input id="${escapeHtml(inputId)}" class="dialog-input" type="text" value="${escapeHtml(defaultValue || '')}" autocomplete="off" />
          </label>
          <div class="actions">
            <button type="button" data-action="cancel">${escapeHtml(cancelText)}</button>
            <button type="button" data-action="confirm">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);
      const input = backdrop.querySelector(`#${inputId}`);
      const close = (result) => {
        backdrop.remove();
        resolve(result);
      };
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(null);
      });
      backdrop.querySelector('[data-action="cancel"]').addEventListener('click', () => close(null));
      backdrop.querySelector('[data-action="confirm"]').addEventListener('click', () => close(input ? input.value : ''));
      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') close(input.value);
        });
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
      }
    });
  }

  function verifyVoteDeletePassword() {
    return verifyAdminPassword(
      '투표 종료/삭제',
      '관리자 암호를 확인하면 투표를 정리할 수 있어요.'
    );
  }

  function verifyVoteHistoryDeletePassword() {
    return verifyAdminPassword(
      '이전 투표 기록 삭제',
      '관리자가 지정한 암호로만 이전 투표 기록을 삭제할 수 있습니다.'
    );
  }

  function clearVoteTimer() {
    if (state.voteTimer) { clearInterval(state.voteTimer); state.voteTimer = null; }
  }

  function formatVoteRange(vote) {
    const fmt = (ts) => {
      const d = new Date(ts);
      return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const now = Date.now();
    let suffix = '';
    if (now < vote.startAt) suffix = ` · 시작까지 ${formatDuration(vote.startAt - now)}`;
    else if (now <= vote.endAt) suffix = ` · 종료까지 ${formatDuration(vote.endAt - now)}`;
    else suffix = ' · 종료됨';
    return `${fmt(vote.startAt)} ~ ${fmt(vote.endAt)}${suffix}`;
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}시간 ${m}분`;
    if (m) return `${m}분 ${sec}초`;
    return `${sec}초`;
  }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function getInitialMealTabBySeoulTime() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());

    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    const minutesFromMidnight = hour * 60 + minute;

    const monToThu = ['Mon', 'Tue', 'Wed', 'Thu'];
    const isFriday = weekday === 'Fri';
    const isWeekday = monToThu.includes(weekday) || isFriday;

    // 09:00 ~ 13:00
    const inMorningLunchWindow = minutesFromMidnight >= (9 * 60) && minutesFromMidnight <= (13 * 60);
    if (inMorningLunchWindow) {
      if (isFriday) return 'fridayLunch';
      if (monToThu.includes(weekday)) return 'lunch';
    }

    // 13:30 ~ 19:00
    const inDinnerWindow = minutesFromMidnight >= (13 * 60 + 30) && minutesFromMidnight <= (19 * 60);
    if (isWeekday && inDinnerWindow) return 'dinner';

    return 'lunch';
  }

  function toLocalDtInput(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function getVisibleStores() {
    return getVisibleStoresForMeal(state.meal, { includeMeta: false });
  }

  function getVisibleStoresForMeal(targetMeal, options = {}) {
    const includeMeta = options.includeMeta === true;
    const merged = [];
    MEAL_TYPES.forEach((baseMeal) => {
      Stores.get(baseMeal).forEach((store) => {
        const visibleMeals = getStoreVisibleMeals(store, baseMeal);
        if (!visibleMeals.includes(targetMeal)) return;
        merged.push(includeMeta ? {
          ...store,
          __sourceMeal: baseMeal,
          __isMirrored: baseMeal !== targetMeal,
        } : store);
      });
    });
    return dedupeStoresByUrl(merged);
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

  async function pickRandomFromVisible(n) {
    await loadRandomHistoryForMeal(state.meal);
    const blockedByRecent = getRecentRandomBlockedIds(state.meal);
    const arr = dedupeStoresByUrl(
      getVisibleStores().filter((s) => !isBlockedByCaution(s) && !blockedByRecent.has(s.id))
    );
    const out = [];
    while (arr.length && out.length < n) {
      const idx = Math.floor(Math.random() * arr.length);
      out.push(arr.splice(idx, 1)[0]);
    }
    return out;
  }

  function isBlockedByCaution(store) {
    const cautionNames = new Set(state.cautions.map((c) => c.name));
    const eatingOut = state.assignments.outside.filter((n) => cautionNames.has(n));
    const hasStoreBlocks = state.assignments.outside.some((name) => {
      const keys = state.cautionStoreBlocks[name];
      return Array.isArray(keys) && keys.length > 0;
    });
    if (!eatingOut.length && !hasStoreBlocks) return false;
    const blockedFor = Array.isArray(store.avoidFor) ? store.avoidFor : [];
    if (blockedFor.some((name) => eatingOut.includes(name))) return true;
    const blockedStoreKeys = new Set();
    state.assignments.outside.forEach((name) => {
      const keys = Array.isArray(state.cautionStoreBlocks[name]) ? state.cautionStoreBlocks[name] : [];
      keys.forEach((k) => blockedStoreKeys.add(k));
    });
    if (!blockedStoreKeys.size) return false;
    const storeKey = getStoreBlockKeyFromStore(store, state.meal);
    return blockedStoreKeys.has(storeKey);
  }

  function getStoreVisibleMeals(store, sourceMeal) {
    if (Array.isArray(store.visibleMeals) && store.visibleMeals.length) {
      return [...new Set(store.visibleMeals.filter((m) => MEAL_TYPES.includes(m)))];
    }
    const meals = [sourceMeal];
    if (store.showInFridayLunchTab || store.showInCompanionLunchTab) meals.push('fridayLunch');
    return [...new Set(meals)];
  }

  function mealLabel(meal) {
    return ({
      lunch: '점심',
      fridayLunch: '금요일 점심',
      dinner: '저녁',
    }[meal] || meal);
  }

  async function openDuplicateVisibilityMenu(store, sourceMeal) {
    const current = getStoreVisibleMeals(store, sourceMeal);
    const selected = await showMultiSelectModal({
      title: '중복 허용 설정',
      subtitle: `"${store.name}" 노출 탭을 선택하세요.`,
      options: [
        { value: 'lunch', label: '점심' },
        { value: 'fridayLunch', label: '금요일 점심' },
        { value: 'dinner', label: '저녁' },
      ],
      selected: current,
      saveLabel: '저장',
      requireAtLeastOne: true,
    });
    if (!selected) return;
    await Stores.update(sourceMeal, store.id, {
      visibleMeals: selected,
      showInFridayLunchTab: false,
      showInCompanionLunchTab: false,
    });
    renderSettingsStoreList();
    if (MEAL_TYPES.includes(state.activeTab)) {
      renderStoreList();
      Maps.renderStores(getVisibleStores());
    }
  }

  async function openStoreCautionTagsMenu(store, sourceMeal) {
    if (!state.cautions.length) {
      await showAppAlert('주의 태그 설정', '주의 대상자를 먼저 등록해주세요.');
      return;
    }
    const cautionMap = new Map();
    state.cautions.forEach((c) => {
      if (!cautionMap.has(c.name)) cautionMap.set(c.name, []);
      cautionMap.get(c.name).push(c.note);
    });
    const selected = await showMultiSelectModal({
      title: '주의 태그 설정',
      subtitle: `"${store.name}" 에서 식사 주의가 필요한 대상자를 선택하세요.`,
      options: Array.from(cautionMap.entries()).map(([name, notes]) => ({
        value: name,
        label: `${name} · ${Array.from(new Set(notes)).join(', ')}`,
      })),
      selected: Array.isArray(store.avoidFor) ? store.avoidFor : [],
      saveLabel: '태그 저장',
      requireAtLeastOne: false,
    });
    if (!selected) return;
    await Stores.update(sourceMeal, store.id, { avoidFor: selected });
    renderSettingsStoreList();
    if (MEAL_TYPES.includes(state.activeTab)) {
      renderStoreList();
      Maps.renderStores(getVisibleStores());
    }
  }

  function showMultiSelectModal(config) {
    const title = config.title || '선택';
    const subtitle = config.subtitle || '';
    const options = Array.isArray(config.options) ? config.options : [];
    const selectedSet = new Set(Array.isArray(config.selected) ? config.selected : []);
    const saveLabel = config.saveLabel || '저장';
    const requireAtLeastOne = config.requireAtLeastOne === true;
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'visibility-modal-backdrop';
      backdrop.innerHTML = `
        <div class="visibility-modal" role="dialog" aria-modal="true">
          <h3>${escapeHtml(title)}</h3>
          <p class="muted">${escapeHtml(subtitle)}</p>
          ${options.map((op) => (
            `<label><input type="checkbox" value="${escapeHtml(op.value)}" ${selectedSet.has(op.value) ? 'checked' : ''}/> ${escapeHtml(op.label)}</label>`
          )).join('')}
          <div class="actions">
            <button type="button" data-action="cancel">취소</button>
            <button type="button" data-action="save">${escapeHtml(saveLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);

      const close = (result) => {
        backdrop.remove();
        resolve(result);
      };
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(null);
      });
      backdrop.querySelector('[data-action="cancel"]').addEventListener('click', () => close(null));
      backdrop.querySelector('[data-action="save"]').addEventListener('click', async () => {
        const checked = Array.from(backdrop.querySelectorAll('input[type="checkbox"]:checked'))
          .map((el) => el.value)
          .filter((m) => options.some((op) => op.value === m));
        if (requireAtLeastOne && !checked.length) {
          await showAppAlert(title, '최소 1개 탭은 선택해야 합니다.');
          return;
        }
        close(checked);
      });
    });
  }

  /** UI 표시용 memo 정리 — 옛 placeId:xxx 문자열을 제거. */
  function cleanMemoForDisplay(memo) {
    if (!memo) return '';
    return String(memo)
      .replace(/\s*·\s*placeId:\S+/gi, '')
      .replace(/^placeId:\S+\s*·?\s*/i, '')
      .trim();
  }

  /**
   * 가게 한 줄 메타 표시. placeId 는 의도적으로 노출하지 않음.
   * @param {boolean} showCoords - 좌표 텍스트를 함께 표시할지 여부
   */
  function buildStoreMetaHtml(s, showCoords) {
    const parts = [];
    if (s.address) parts.push(escapeHtml(s.address));
    if (s.category) parts.push(escapeHtml(s.category));
    if (s.phone) parts.push(escapeHtml(s.phone));
    const cleanedMemo = cleanMemoForDisplay(s.memo);
    if (cleanedMemo) parts.push(escapeHtml(cleanedMemo));
    if (Array.isArray(s.avoidFor) && s.avoidFor.length) {
      parts.push(`주의: ${escapeHtml(s.avoidFor.join(', '))}`);
    }
    if (showCoords && s.lat != null && s.lng != null) {
      parts.push(`${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`);
    }
    return parts.join(' · ');
  }

  function getCautionNotesByName(name) {
    return state.cautions
      .filter((c) => c.name === name)
      .map((c) => c.note)
      .filter((note, idx, arr) => note && arr.indexOf(note) === idx);
  }

  function renderCautionStoreBlockSummary() {
    const summary = $('#caution-store-block-summary');
    const personEl = $('#caution-person');
    if (!summary || !personEl) return;
    const personName = (personEl.value || '').trim();
    if (!personName) {
      summary.textContent = '선택된 못가는 가게가 없습니다.';
      return;
    }
    const blockedKeys = Array.isArray(state.cautionStoreBlocks[personName]) ? state.cautionStoreBlocks[personName] : [];
    if (!blockedKeys.length) {
      summary.textContent = `${personName} 대상자의 못가는 가게가 없습니다.`;
      return;
    }
    const blockedNames = blockedKeys.map((k) => getStoreLabelByBlockKey(k)).filter(Boolean);
    summary.textContent = `${personName} 제외 가게: ${blockedNames.join(', ')}`;
  }

  function getStoreBlockOptions() {
    const seen = new Set();
    const out = [];
    MEAL_TYPES.forEach((meal) => {
      Stores.get(meal).forEach((store) => {
        const key = getStoreBlockKeyFromStore(store, meal);
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push({
          value: key,
          label: `${mealLabel(meal)} · ${store.name}`,
        });
      });
    });
    return out.sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  }

  function getStoreBlockOptionsByMeal(filterFn) {
    const byMeal = {
      all: [],
      lunch: [],
      fridayLunch: [],
      dinner: [],
    };
    MEAL_TYPES.forEach((meal) => {
      const visible = getVisibleStoresForMeal(meal, { includeMeta: true });
      visible.forEach((store) => {
        if (filterFn && !filterFn(store)) return;
        const key = getStoreBlockKeyFromStore(store, meal);
        if (!key) return;
        byMeal[meal].push({
          value: key,
          label: store.name,
          memo: cleanMemoForDisplay(store.memo || ''),
        });
      });
    });
    const allMap = new Map();
    MEAL_TYPES.forEach((meal) => {
      (byMeal[meal] || []).forEach((op) => {
        if (allMap.has(op.value)) return;
        allMap.set(op.value, { ...op });
      });
    });
    byMeal.all = Array.from(allMap.values());
    MEAL_TYPES.forEach((meal) => {
      byMeal[meal].sort((a, b) => a.label.localeCompare(b.label, 'ko'));
    });
    byMeal.all.sort((a, b) => a.label.localeCompare(b.label, 'ko'));
    return byMeal;
  }

  function getStoreLabelByBlockKey(blockKey) {
    const byMeal = getStoreBlockOptionsByMeal();
    const all = [...byMeal.lunch, ...byMeal.fridayLunch, ...byMeal.dinner];
    const found = all.find((op) => op.value === blockKey);
    return found ? found.label : blockKey;
  }

  function getStoreBlockKeyFromStore(store, mealFallback) {
    const normUrl = normalizeUrlForCompare(store && store.url);
    if (normUrl) return `url:${normUrl}`;
    const sourceMeal = (store && store.__sourceMeal) || mealFallback || state.meal || 'lunch';
    return `id:${sourceMeal}:${store && store.id ? store.id : ''}`;
  }

  function resolveStoresFromBlockKeys(keys) {
    const out = [];
    const seen = new Set();
    (keys || []).forEach((key) => {
      if (!key || seen.has(key)) return;
      for (const meal of MEAL_TYPES) {
        const visible = getVisibleStoresForMeal(meal, { includeMeta: true });
        const found = visible.find((s) => getStoreBlockKeyFromStore(s, meal) === key);
        if (found) {
          seen.add(key);
          out.push({ id: found.id, name: found.name });
          break;
        }
      }
    });
    return out;
  }

  async function openStorePickerModal(config) {
    const {
      title = '가게 선택',
      subtitle = '',
      saveLabel = '저장',
      minSelect = 0,
      maxSelect = Number.MAX_SAFE_INTEGER,
      initialSelected = [],
      filterFn = null,
      returnMode = 'stores',
    } = config || {};
    const byMeal = getStoreBlockOptionsByMeal(filterFn);
    const totalCount = MEAL_TYPES.reduce((sum, meal) => sum + byMeal[meal].length, 0);
    if (!totalCount) {
      await showAppAlert(title, '등록된 가게가 없어 선택할 수 없습니다.');
      return null;
    }
    const selectedSet = new Set(Array.isArray(initialSelected) ? initialSelected : []);
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'visibility-modal-backdrop';
      backdrop.innerHTML = `
        <div class="visibility-modal store-block-modal" role="dialog" aria-modal="true">
          <h3>${escapeHtml(title)}</h3>
          <p class="muted">${escapeHtml(subtitle)}</p>
          <div class="store-block-tabs">
            <button type="button" class="store-block-tab active" data-meal="all">전체</button>
            <button type="button" class="store-block-tab" data-meal="lunch">점심</button>
            <button type="button" class="store-block-tab" data-meal="fridayLunch">금요일 점심</button>
            <button type="button" class="store-block-tab" data-meal="dinner">저녁</button>
          </div>
          <div class="store-block-search-row">
            <input type="text" id="store-block-search" class="store-search-input" placeholder="가게 이름 검색" />
            <button type="button" class="store-block-bulk-btn" data-action="check-filtered">검색결과 전체 체크</button>
            <button type="button" class="store-block-bulk-btn" data-action="uncheck-filtered">검색결과 전체 해제</button>
          </div>
          <div class="store-block-list" id="store-block-list"></div>
          <div class="actions">
            <button type="button" data-action="cancel">취소</button>
            <button type="button" data-action="save">${escapeHtml(saveLabel)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);

      const listEl = backdrop.querySelector('#store-block-list');
      const searchEl = backdrop.querySelector('#store-block-search');
      let activeMeal = 'all';
      let keyword = '';
      const renderMealList = () => {
        const options = byMeal[activeMeal] || [];
        const filtered = keyword
          ? options.filter((op) => op.label.toLowerCase().includes(keyword))
          : options;
        if (!filtered.length) {
          listEl.innerHTML = '<div class="vote-history-meta">해당 식사 탭에 등록된 가게가 없습니다.</div>';
          return;
        }
        listEl.innerHTML = filtered.map((op) => `
          <label class="store-block-option">
            <input type="checkbox" value="${escapeHtml(op.value)}" ${selectedSet.has(op.value) ? 'checked' : ''}/>
            <span class="store-block-option-text">
              <span class="store-block-option-name">${escapeHtml(op.label)}</span>
              ${op.memo ? `<span class="store-block-option-memo">${escapeHtml(op.memo)}</span>` : ''}
            </span>
          </label>
        `).join('');
        Array.from(listEl.querySelectorAll('input[type="checkbox"]')).forEach((cb) => {
          cb.addEventListener('change', () => {
            if (cb.checked) selectedSet.add(cb.value);
            else selectedSet.delete(cb.value);
          });
        });
      };

      const close = (result) => {
        backdrop.remove();
        resolve(result);
      };
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(null);
      });
      Array.from(backdrop.querySelectorAll('.store-block-tab')).forEach((btn) => {
        btn.addEventListener('click', () => {
          activeMeal = btn.dataset.meal;
          keyword = '';
          if (searchEl) searchEl.value = '';
          Array.from(backdrop.querySelectorAll('.store-block-tab'))
            .forEach((el) => el.classList.toggle('active', el === btn));
          renderMealList();
        });
      });
      if (searchEl) {
        searchEl.addEventListener('input', () => {
          keyword = (searchEl.value || '').trim().toLowerCase();
          renderMealList();
        });
      }
      const checkFilteredBtn = backdrop.querySelector('[data-action="check-filtered"]');
      if (checkFilteredBtn) {
        checkFilteredBtn.addEventListener('click', () => {
          const options = byMeal[activeMeal] || [];
          const filtered = keyword
            ? options.filter((op) => op.label.toLowerCase().includes(keyword))
            : options;
          filtered.forEach((op) => selectedSet.add(op.value));
          renderMealList();
        });
      }
      const uncheckFilteredBtn = backdrop.querySelector('[data-action="uncheck-filtered"]');
      if (uncheckFilteredBtn) {
        uncheckFilteredBtn.addEventListener('click', () => {
          const options = byMeal[activeMeal] || [];
          const filtered = keyword
            ? options.filter((op) => op.label.toLowerCase().includes(keyword))
            : options;
          filtered.forEach((op) => selectedSet.delete(op.value));
          renderMealList();
        });
      }
      backdrop.querySelector('[data-action="cancel"]').addEventListener('click', () => close(null));
      backdrop.querySelector('[data-action="save"]').addEventListener('click', async () => {
        const keys = Array.from(selectedSet);
        if (keys.length < minSelect) {
          await showAppAlert(title, `최소 ${minSelect}개 이상 선택해주세요.`);
          return;
        }
        if (keys.length > maxSelect) {
          await showAppAlert(title, `최대 ${maxSelect}개까지만 선택할 수 있습니다.`);
          return;
        }
        if (returnMode === 'keys') close(keys);
        else close(resolveStoresFromBlockKeys(keys));
      });
      renderMealList();
    });
  }

  function openCautionStoreBlocksEditor(personName) {
    const initial = Array.isArray(state.cautionStoreBlocks[personName])
      ? state.cautionStoreBlocks[personName]
      : [];
    return openStorePickerModal({
      title: '못가는 가게 선택',
      subtitle: `${personName} 대상자의 제외 가게를 설정하세요.`,
      saveLabel: '저장',
      minSelect: 0,
      maxSelect: Number.MAX_SAFE_INTEGER,
      initialSelected: initial,
      returnMode: 'keys',
    });
  }

  function renderCautionPersonOptions() {
    const personSelect = $('#caution-person');
    if (!personSelect) return;
    const prev = personSelect.value;
    personSelect.innerHTML = '<option value="">대상자를 선택하세요</option>';
    state.people.forEach((p) => {
      const op = document.createElement('option');
      op.value = p.name;
      op.textContent = p.role ? `${p.name} ${p.role}` : p.name;
      personSelect.appendChild(op);
    });
    if (state.people.some((p) => p.name === prev)) {
      personSelect.value = prev;
    } else {
      personSelect.value = '';
    }
    renderCautionStoreBlockSummary();
  }

  // ---------- Storage 오류 배너 ----------
  function bindStorageErrors() {
    let lastShownAt = 0;
    window.addEventListener('storage-error', (e) => {
      const now = Date.now();
      if (now - lastShownAt < 4000) return;
      lastShownAt = now;
      const banner = $('#storage-error-banner');
      if (!banner) return;
      const detail = (e.detail || {});
      banner.innerHTML = `
        ⚠️ Azure 저장소 연결 오류 (${escapeHtml(String(detail.status || 'network'))}).
        브라우저 콘솔(F12)에서 자세한 메시지를 확인하세요.
        <br/><small>가능한 원인: 테이블 미생성 / CORS 미설정 / SAS 만료.</small>
      `;
      banner.classList.remove('hidden');
      setTimeout(() => banner.classList.add('hidden'), 8000);
    });
  }
})();
