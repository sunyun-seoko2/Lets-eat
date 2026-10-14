/**
 * Azure Table Storage REST 클라이언트 (js/storage-azure.js 와 같은 방식, SAS 인증).
 */
const TABLES = {
  stores: () => process.env.TABLE_STORES || 'stores',
  votes: () => process.env.TABLE_VOTES || 'votes',
  people: () => process.env.TABLE_PEOPLE || 'people',
  randomHistory: () => process.env.TABLE_RANDOM_HISTORY || 'randomhistory',
};

const ROULETTE_HISTORY_PK = 'roulette_history';

const COMMON_HEADERS = {
  'Accept': 'application/json;odata=nometadata',
  'Content-Type': 'application/json',
  'x-ms-version': '2019-02-02',
};

function getConfig() {
  const account = process.env.STORAGE_ACCOUNT;
  const sas = String(process.env.STORAGE_SAS || '').replace(/^\?/, '');
  if (!account || !sas) throw new Error('STORAGE_ACCOUNT / STORAGE_SAS 앱 설정이 없습니다.');
  return { base: `https://${account}.table.core.windows.net`, sas };
}

function escapeOData(s) { return String(s).replace(/'/g, "''"); }

function entityUrl(table, pk, rk) {
  const { base, sas } = getConfig();
  return `${base}/${table}(PartitionKey='${escapeOData(pk)}',RowKey='${escapeOData(rk)}')?${sas}`;
}

function listUrl(table, filter, next) {
  const { base, sas } = getConfig();
  let url = `${base}/${table}()?${sas}&$filter=${encodeURIComponent(filter)}`;
  if (next && next.pk) {
    url += `&NextPartitionKey=${encodeURIComponent(next.pk)}`;
    if (next.rk != null) url += `&NextRowKey=${encodeURIComponent(next.rk)}`;
  }
  return url;
}

// SAS 토큰이 로그에 남지 않도록 오류 메시지에는 URL 을 넣지 않음
async function failure(op, res) {
  let text = '';
  try { text = (await res.text()).slice(0, 300); } catch { /* ignore */ }
  return new Error(`Azure ${op} failed: ${res.status} ${text}`);
}

async function listEntities(table, pk) {
  const out = [];
  let next = null;
  do {
    const res = await fetch(listUrl(table, `PartitionKey eq '${escapeOData(pk)}'`, next), {
      method: 'GET', headers: COMMON_HEADERS, signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw await failure(`list ${table}/${pk}`, res);
    const data = await res.json();
    out.push(...(data.value || []));
    const nextPk = res.headers.get('x-ms-continuation-NextPartitionKey');
    const nextRk = res.headers.get('x-ms-continuation-NextRowKey');
    next = nextPk ? { pk: nextPk, rk: nextRk } : null;
  } while (next);
  return out;
}

async function getEntity(table, pk, rk) {
  const res = await fetch(entityUrl(table, pk, rk), { method: 'GET', headers: COMMON_HEADERS, signal: AbortSignal.timeout(15000) });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(`get ${table}/${pk}/${rk}`, res);
  return res.json();
}

// If-Match 없이 PUT = Insert Or Replace (upsert)
async function putEntity(table, pk, rk, obj) {
  const res = await fetch(entityUrl(table, pk, rk), {
    method: 'PUT',
    signal: AbortSignal.timeout(15000),
    headers: COMMON_HEADERS,
    body: JSON.stringify({ PartitionKey: pk, RowKey: rk, Payload: JSON.stringify(obj) }),
  });
  if (!res.ok && res.status !== 204) throw await failure(`put ${table}/${pk}/${rk}`, res);
}

async function deleteEntity(table, pk, rk) {
  const res = await fetch(entityUrl(table, pk, rk), {
    method: 'DELETE',
    signal: AbortSignal.timeout(15000),
    headers: { ...COMMON_HEADERS, 'If-Match': '*' },
  });
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    throw await failure(`delete ${table}/${pk}/${rk}`, res);
  }
}

function parsePayload(entity) {
  if (!entity || !entity.Payload) return null;
  try { return JSON.parse(entity.Payload); } catch { return null; }
}

// ---------- 앱 데이터 접근 ----------
async function getStores(meal) {
  return (await listEntities(TABLES.stores(), meal)).map(parsePayload).filter(Boolean);
}

async function getRoulette(meal) {
  return parsePayload(await getEntity(TABLES.votes(), meal, 'roulette_current'));
}

async function saveRoulette(meal, session) {
  await putEntity(TABLES.votes(), meal, 'roulette_current', session || null);
}

async function getRouletteHistory() {
  return (await listEntities(TABLES.votes(), ROULETTE_HISTORY_PK)).map(parsePayload).filter(Boolean);
}

async function saveRouletteHistory(record) {
  await putEntity(TABLES.votes(), ROULETTE_HISTORY_PK, String(record.id), record);
}

async function deleteRouletteHistory(id) {
  await deleteEntity(TABLES.votes(), ROULETTE_HISTORY_PK, String(id));
}

async function getRandomHistory(meal) {
  return (await listEntities(TABLES.randomHistory(), meal)).map(parsePayload).filter(Boolean);
}

async function saveRandomHistory(meal, record) {
  await putEntity(TABLES.randomHistory(), meal, String(record.id), record);
}

async function getPeopleBundle() {
  const payload = parsePayload(await getEntity(TABLES.people(), 'shared', 'current'));
  if (!payload || typeof payload !== 'object') {
    return { people: [], cautions: [], cautionStoreBlocks: {}, assignments: { outside: [], lunchbox: [] }, assignmentPins: {} };
  }
  return payload;
}

module.exports = {
  getStores,
  getRoulette,
  saveRoulette,
  getRouletteHistory,
  saveRouletteHistory,
  deleteRouletteHistory,
  getRandomHistory,
  saveRandomHistory,
  getPeopleBundle,
};
