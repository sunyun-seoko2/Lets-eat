/**
 * Azure Table Storage adapter.
 *
 * 데이터 모델:
 *   stores 테이블: PartitionKey = meal key (예: lunch | dinner | fridayLunch), RowKey = store.id,
 *                  Payload (JSON 문자열, 가게 정보 전체)
 *   votes  테이블: PartitionKey = meal key (예: lunch | dinner | fridayLunch), RowKey = 'current'|'roulette_current',
 *                  Payload (JSON 문자열, 투표/룰렛 정보 전체)
 *   people 테이블: PartitionKey = 'shared', RowKey = 'current',
 *                  Payload (JSON 문자열, 대상자/입맛보호/오늘점심구분 데이터)
 *   randomhistory 테이블: PartitionKey = meal key, RowKey = random history id,
 *                  Payload (JSON 문자열, 룰렛/투표 후보 무작위 선정 기록)
 *
 * window.AppConfig.storage === 'azure' 일 때 자동으로 window.Storage 를 덮어씁니다.
 * 그렇지 않으면 storage.js 의 localStorage 어댑터가 유지됩니다.
 *
 * ⚠️ SAS 토큰은 클라이언트 코드에 노출됩니다. 공개·편집 가능 모드 전제.
 */
(function () {
  if (!window.AppConfig || window.AppConfig.storage !== 'azure') {
    console.info('[storage-azure] storage != "azure", skipping (using localStorage).');
    return;
  }

  const cfg = window.AppConfig.azure || {};
  const ACCOUNT = cfg.account;
  const SAS = (cfg.sas || '').replace(/^\?/, '');
  const TABLE_STORES = cfg.tableStores || 'stores';
  const TABLE_VOTES  = cfg.tableVotes  || 'votes';
  const TABLE_PEOPLE = cfg.tablePeople || 'people';
  const TABLE_RANDOM_HISTORY = cfg.tableRandomHistory || 'randomhistory';

  if (!ACCOUNT || !SAS) {
    console.error('[storage-azure] account 또는 sas 가 설정되지 않았습니다. localStorage 로 폴백.');
    return;
  }

  const BASE = `https://${ACCOUNT}.table.core.windows.net`;
  const COMMON_HEADERS = {
    'Accept': 'application/json;odata=nometadata',
    'Content-Type': 'application/json',
    'x-ms-version': '2019-02-02',
  };

  function escapeOData(s) { return String(s).replace(/'/g, "''"); }
  function entityUrl(table, pk, rk) {
    return `${BASE}/${table}(PartitionKey='${escapeOData(pk)}',RowKey='${escapeOData(rk)}')?${SAS}`;
  }
  function listUrl(table, filter) {
    const f = filter ? `&$filter=${encodeURIComponent(filter)}` : '';
    return `${BASE}/${table}()?${SAS}${f}`;
  }

  function reportError(op, status, message) {
    console.error(`[azure] ${op} → ${status}`, message || '');
    try {
      window.dispatchEvent(new CustomEvent('storage-error', {
        detail: { op, status, message: String(message || '').slice(0, 300) },
      }));
    } catch { /* ignore */ }
  }

  /** Tables 가 없으면 생성. 이미 있으면 409 → no-op. */
  async function createTable(name) {
    try {
      const res = await fetch(`${BASE}/Tables?${SAS}`, {
        method: 'POST',
        headers: COMMON_HEADERS,
        body: JSON.stringify({ TableName: name }),
      });
      if (res.status === 201) {
        console.info(`[azure] created table "${name}"`);
        return true;
      }
      if (res.status === 409) return true; // already exists
      const t = await res.text();
      reportError(`createTable ${name}`, res.status, t);
      return false;
    } catch (e) {
      reportError(`createTable ${name}`, 'network', e.message);
      return false;
    }
  }

  let initPromise = null;
  function ensureInit() {
    if (!initPromise) {
      initPromise = Promise.all([
        createTable(TABLE_STORES),
        createTable(TABLE_VOTES),
        createTable(TABLE_PEOPLE),
        createTable(TABLE_RANDOM_HISTORY),
      ]).then(([a, b, c, d]) => {
        if (a && b && c && d) console.info('[azure] tables ready.');
      });
    }
    return initPromise;
  }

  async function listEntities(table, pk) {
    try {
      const res = await fetch(listUrl(table, `PartitionKey eq '${escapeOData(pk)}'`), {
        method: 'GET', headers: COMMON_HEADERS,
      });
      if (!res.ok) {
        reportError(`list ${table}/${pk}`, res.status, await res.text());
        return [];
      }
      const data = await res.json();
      return data.value || [];
    } catch (e) {
      reportError(`list ${table}/${pk}`, 'network', e.message);
      return [];
    }
  }

  async function getEntity(table, pk, rk) {
    try {
      const res = await fetch(entityUrl(table, pk, rk), {
        method: 'GET', headers: COMMON_HEADERS,
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        reportError(`get ${table}/${pk}/${rk}`, res.status, await res.text());
        return null;
      }
      return await res.json();
    } catch (e) {
      reportError(`get ${table}/${pk}/${rk}`, 'network', e.message);
      return null;
    }
  }

  async function putEntity(table, pk, rk, props) {
    const body = { PartitionKey: pk, RowKey: rk, ...props };
    try {
      // If-Match 없이 PUT = Insert Or Replace Entity (upsert).
      // If-Match: * 를 붙이면 Update Entity 가 되어 신규 엔티티 등록 시 404 발생.
      const res = await fetch(entityUrl(table, pk, rk), {
        method: 'PUT',
        headers: COMMON_HEADERS,
        body: JSON.stringify(body),
      });
      if (!res.ok && res.status !== 204) {
        const t = await res.text();
        reportError(`put ${table}/${pk}/${rk}`, res.status, t);
        throw new Error(`Azure PUT failed: ${res.status}`);
      }
    } catch (e) {
      if (!String(e.message).startsWith('Azure ')) {
        reportError(`put ${table}/${pk}/${rk}`, 'network', e.message);
      }
      throw e;
    }
  }

  async function deleteEntity(table, pk, rk) {
    try {
      const res = await fetch(entityUrl(table, pk, rk), {
        method: 'DELETE',
        headers: { ...COMMON_HEADERS, 'If-Match': '*' },
      });
      if (!res.ok && res.status !== 204 && res.status !== 404) {
        const t = await res.text();
        reportError(`delete ${table}/${pk}/${rk}`, res.status, t);
        throw new Error(`Azure DELETE failed: ${res.status}`);
      }
    } catch (e) {
      if (!String(e.message).startsWith('Azure ')) {
        reportError(`delete ${table}/${pk}/${rk}`, 'network', e.message);
      }
      throw e;
    }
  }

  function parsePayload(entity) {
    if (!entity || !entity.Payload) return null;
    try { return JSON.parse(entity.Payload); } catch { return null; }
  }

  const AzureStorage = {
    async getStores(meal) {
      await ensureInit();
      const entities = await listEntities(TABLE_STORES, meal);
      return entities.map(parsePayload).filter(Boolean);
    },

    async saveStores(meal, stores) {
      await ensureInit();
      let existing = [];
      try { existing = await listEntities(TABLE_STORES, meal); } catch (e) { /* ignore */ }
      const newIds = new Set(stores.map((s) => s.id));

      const toDelete = existing.filter((e) => !newIds.has(e.RowKey));
      await Promise.all(toDelete.map((e) =>
        deleteEntity(TABLE_STORES, meal, e.RowKey).catch((err) => console.error('del:', err))
      ));

      await Promise.all(stores.map((s) =>
        putEntity(TABLE_STORES, meal, s.id, { Payload: JSON.stringify(s) })
          .catch((err) => console.error('put:', err))
      ));
    },

    async getVote(meal) {
      await ensureInit();
      const e = await getEntity(TABLE_VOTES, meal, 'current');
      return parsePayload(e);
    },

    async saveVote(meal, vote) {
      await ensureInit();
      await putEntity(TABLE_VOTES, meal, 'current', { Payload: JSON.stringify(vote) });
    },

    async clearVote(meal) {
      await ensureInit();
      await deleteEntity(TABLE_VOTES, meal, 'current');
    },

    async getRoulette(meal) {
      await ensureInit();
      const e = await getEntity(TABLE_VOTES, meal, 'roulette_current');
      return parsePayload(e);
    },

    async saveRoulette(meal, roulette) {
      await ensureInit();
      await putEntity(TABLE_VOTES, meal, 'roulette_current', { Payload: JSON.stringify(roulette || null) });
    },

    async clearRoulette(meal) {
      await ensureInit();
      await deleteEntity(TABLE_VOTES, meal, 'roulette_current');
    },

    async getVoteHistory(meal) {
      await ensureInit();
      const entities = await listEntities(TABLE_VOTES, meal);
      return entities
        .filter((e) => String(e.RowKey || '').startsWith('history_'))
        .map(parsePayload)
        .filter(Boolean);
    },

    async saveVoteHistory(meal, record) {
      await ensureInit();
      const safe = (record && typeof record === 'object') ? record : {};
      const rowKey = `history_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await putEntity(TABLE_VOTES, meal, rowKey, { Payload: JSON.stringify(safe) });
    },

    async deleteVoteHistory(meal, recordId) {
      await ensureInit();
      const entities = await listEntities(TABLE_VOTES, meal);
      const target = entities.find((e) => {
        if (!String(e.RowKey || '').startsWith('history_')) return false;
        const payload = parsePayload(e);
        return payload && String(payload.id) === String(recordId);
      });
      if (target) await deleteEntity(TABLE_VOTES, meal, target.RowKey);
    },

    async clearVoteHistory(meal) {
      await ensureInit();
      const entities = await listEntities(TABLE_VOTES, meal);
      await Promise.all(
        entities
          .filter((e) => String(e.RowKey || '').startsWith('history_'))
          .map((e) => deleteEntity(TABLE_VOTES, meal, e.RowKey))
      );
    },

    async getRandomHistory(meal) {
      await ensureInit();
      const entities = await listEntities(TABLE_RANDOM_HISTORY, meal);
      return entities.map(parsePayload).filter(Boolean);
    },

    async saveRandomHistory(meal, record) {
      await ensureInit();
      const safe = (record && typeof record === 'object') ? record : {};
      const rowKey = String(safe.id || `rh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
      if (!safe.id) safe.id = rowKey;
      await putEntity(TABLE_RANDOM_HISTORY, meal, rowKey, { Payload: JSON.stringify(safe) });
    },

    async deleteRandomHistory(meal, recordId) {
      await ensureInit();
      await deleteEntity(TABLE_RANDOM_HISTORY, meal, String(recordId));
    },

    async clearRandomHistory(meal) {
      await ensureInit();
      const entities = await listEntities(TABLE_RANDOM_HISTORY, meal);
      await Promise.all(entities.map((e) =>
        deleteEntity(TABLE_RANDOM_HISTORY, meal, e.RowKey).catch((err) => console.error('clear random history delete:', err))
      ));
    },

    async getPeopleBundle() {
      await ensureInit();
      const e = await getEntity(TABLE_PEOPLE, 'shared', 'current');
      const payload = parsePayload(e);
      if (!payload || typeof payload !== 'object') {
        return {
          people: [],
          cautions: [],
          assignments: { outside: [], lunchbox: [] },
          assignmentPins: {},
          resetDate: '',
        };
      }
      return payload;
    },

    async savePeopleBundle(bundle) {
      await ensureInit();
      const safe = (bundle && typeof bundle === 'object') ? bundle : {};
      await putEntity(TABLE_PEOPLE, 'shared', 'current', { Payload: JSON.stringify(safe) });
    },

    async getWeeklyResetAt() {
      await ensureInit();
      const e = await getEntity(TABLE_VOTES, '_meta', 'weekly_reset');
      const payload = parsePayload(e);
      const n = Number(payload && payload.at);
      return Number.isFinite(n) ? n : 0;
    },

    async setWeeklyResetAt(ts) {
      await ensureInit();
      await putEntity(TABLE_VOTES, '_meta', 'weekly_reset', {
        Payload: JSON.stringify({ at: Number(ts) || 0 }),
      });
    },
  };

  // 페이지 로드 직후 백그라운드로 테이블 보장
  ensureInit();

  window.Storage = AzureStorage;
  console.info(`[storage-azure] using account "${ACCOUNT}" tables: ${TABLE_STORES}, ${TABLE_VOTES}, ${TABLE_PEOPLE}, ${TABLE_RANDOM_HISTORY}`);
})();
