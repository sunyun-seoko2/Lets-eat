/**
 * 평일 11:00 (KST) 점심 룰렛 서버 실행 + Teams 알림.
 * 시간 트리거는 UTC 기준: 02:00 UTC = 11:00 KST (Linux Flex Consumption 은 WEBSITE_TIME_ZONE 미지원)
 */
const { app } = require('@azure/functions');
const tables = require('../tables');
const R = require('../roulette');
const teams = require('../teams');

const ROULETTE_HISTORY_MAX = 15;
const AUTO_START_MINUTES = 11 * 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 20 * 1000;
const AUTO_END_MINUTES = 13 * 60;

/**
 * 읽기 -> 후보 선정 -> 세션 저장 단계. 이미 실행됐으면 null.
 * 저장 직전에 한 번 더 hasAutoRouletteRunToday 를 확인한다.
 */
async function prepareAndSave(context) {
  const nowTs = Date.now();
  const parts = R.getSeoulDateTimeParts(nowTs);
  const meal = R.getAutoRouletteMealToday(parts);
  if (!meal) {
    context.log(`평일이 아니므로 건너뜀 (${parts.dateKey} ${parts.weekday})`);
    return null;
  }
  const todayKey = parts.dateKey;

  const current = await tables.getRoulette(meal);
  if (R.hasAutoRouletteRunToday(current, todayKey)) {
    context.log(`오늘(${todayKey}) ${meal} 룰렛은 이미 실행됨 - 건너뜀`);
    return null;
  }

  const [lunch, dinner, fridayLunch] = await Promise.all(R.MEAL_TYPES.map((m) => tables.getStores(m)));
  const storesByMeal = { lunch, dinner, fridayLunch };
  const peopleBundle = await tables.getPeopleBundle();
  const peopleState = R.buildPeopleState(peopleBundle, nowTs);
  const history = R.normalizeRandomHistory(await tables.getRandomHistory(meal), meal, nowTs);

  const items = R.pickRandomFromVisible(5, meal, R.createSeededRandom(`${todayKey}:${meal}:pick`), {
    storesByMeal, history, peopleState,
  }).map((s) => ({ id: s.id, name: s.name }));
  context.log(`후보 ${items.length}개: ${items.map((it) => it.name).join(', ')}`);

  if (items.length < 2) {
    const autoNote = '11:00 자동 룰렛: 후보가 부족해 돌리지 못했습니다. 가게를 추가하거나 설정 > 기록 관리를 확인해주세요.';
    if (await alreadyRan(meal, todayKey, context)) return null;
    await tables.saveRoulette(meal, {
      status: 'cleared',
      items: [],
      autoRunDate: todayKey,
      autoNote,
      updatedAt: Date.now(),
    });
    return { insufficient: true, parts, meal, autoNote };
  }

  const random = R.createSeededRandom(`${todayKey}:${meal}:${items.map((it) => it.id).join(',')}`);
  const winner = items[Math.floor(random() * items.length)];
  const now = Date.now();
  const id = `rauto_${meal}_${todayKey}`;
  const leadMs = envNumber('ROULETTE_SPIN_LEAD_MS', 5000);
  const durationMs = envNumber('ROULETTE_SPIN_DURATION_MS', 8000);
  const session = {
    id,
    meal,
    mode: 'random',
    status: 'spinning',
    auto: true,
    server: true,
    autoRunDate: todayKey,
    items,
    winnerId: winner.id,
    winnerName: winner.name,
    spunAt: now,
    // 폴링 중인 브라우저가 시작 전에 세션을 받을 수 있도록 5초 리드
    startAt: Math.ceil(now / 5000) * 5000 + leadMs,
    durationMs,
    spinTurns: 5 + Math.floor(random() * 3),
    startRotation: 0,
    updatedAt: now,
  };

  // 세션을 가장 먼저 저장 (여기까지의 오류는 재시도 후 throw)
  if (await alreadyRan(meal, todayKey, context)) return null;
  await tables.saveRoulette(meal, session);
  context.log(`룰렛 세션 저장: ${winner.name} (${id})`);
  return { parts, meal, storesByMeal, history, items, winner, session, id, durationMs };
}

async function alreadyRan(meal, todayKey, context) {
  const latest = await tables.getRoulette(meal);
  if (R.hasAutoRouletteRunToday(latest, todayKey)) {
    context.log('저장 직전 확인: 이미 실행됨 - 건너뜀');
    return true;
  }
  return false;
}

async function runLunchRoulette(timer, context) {
  if (timer && timer.isPastDue) {
    const p = R.getSeoulDateTimeParts(Date.now());
    if (!R.getAutoRouletteMealToday(p) || p.hour * 60 + p.minute >= AUTO_END_MINUTES) {
      context.log('지연 실행(isPastDue)이며 룰렛 시간대가 지나 건너뜀');
      return;
    }
  }

  let prepared = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      prepared = await prepareAndSave(context);
      break;
    } catch (e) {
      context.error(`룰렛 준비 실패 (${attempt}/${MAX_ATTEMPTS}):`, e && e.message ? e.message : e);
      if (attempt === MAX_ATTEMPTS) throw e;
      await sleep(RETRY_DELAY_MS);
    }
  }
  if (!prepared) return;

  if (prepared.insufficient) {
    await teams.postCard(teams.buildInsufficientCard({
      parts: prepared.parts, meal: prepared.meal, note: prepared.autoNote,
    }), context);
    return;
  }
  const { parts, meal, storesByMeal, history, items, winner, session, id, durationMs } = prepared;

  // 이후 단계는 실패해도 Teams 알림은 계속 진행
  const winnerStore = R.findStoreById(storesByMeal, winner.id);
  const walk = R.estimateWalk(winnerStore);

  try {
    const ref = `roulette:${id}`;
    if (R.isWorkdayForRecording(Date.now()) && !history.some((r) => r.sourceRef === ref)) {
      await tables.saveRandomHistory(meal, {
        id: `rh_${id}`,
        storeId: winner.id,
        storeName: winner.name || '',
        source: 'rouletteWinner',
        sourceRef: ref,
        createdAt: Date.now(),
      });
    }
  } catch (e) {
    context.error('랜덤 기록 저장 실패:', e.message);
  }

  try {
    await tables.saveRouletteHistory({
      id,
      meal,
      spunAt: session.startAt,
      winnerId: winner.id,
      winnerName: winner.name,
      onTime: parts.hour * 60 + parts.minute === AUTO_START_MINUTES,
      walk,
      by: 'server',
    });
    const rows = await tables.getRouletteHistory();
    const old = [...rows]
      .sort((a, b) => (b.spunAt || 0) - (a.spunAt || 0))
      .slice(ROULETTE_HISTORY_MAX);
    for (const row of old) await tables.deleteRouletteHistory(row.id);
  } catch (e) {
    context.error('룰렛 기록 저장 실패:', e.message);
  }

  // 브라우저 회전 연출이 끝난 뒤에 알림 (결과 스포일러 방지)
  const waitMs = session.startAt + durationMs + 1000 - Date.now();
  if (waitMs > 0) await sleep(waitMs);

  await teams.postCard(teams.buildCard({
    parts,
    meal,
    winnerName: winner.name,
    store: winnerStore,
  }), context);
}

app.timer('lunchRoulette', {
  schedule: '0 0 2 * * 1-5',
  runOnStartup: false,
  handler: async (timer, context) => {
    try {
      await runLunchRoulette(timer, context);
    } catch (e) {
      context.error('lunchRoulette 실패:', e && e.stack ? e.stack : e);
      throw e;
    }
  },
});
