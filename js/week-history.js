/**
 * 주간 기록 규칙 (서울 시간)
 * - 월~금 결과만 기록
 * - 매주 토요일 10:00에 지난 주 기록 일괄 초기화
 */
(function () {
  const TZ = 'Asia/Seoul';
  const DAY_MS = 24 * 60 * 60 * 1000;

  function getSeoulParts(ts = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ts));
    return {
      year: Number(parts.find((p) => p.type === 'year')?.value || 0),
      month: Number(parts.find((p) => p.type === 'month')?.value || 1),
      day: Number(parts.find((p) => p.type === 'day')?.value || 1),
      hour: Number(parts.find((p) => p.type === 'hour')?.value || 0),
      minute: Number(parts.find((p) => p.type === 'minute')?.value || 0),
    };
  }

  function getSeoulWeekday(ts = Date.now()) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date(ts));
    return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[wd] ?? 0;
  }

  function seoulWallTimeToMs(year, month, day, hour, minute) {
    return Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0);
  }

  function addSeoulDays(ts, deltaDays) {
    return ts + deltaDays * DAY_MS;
  }

  function daysBackToSaturday(ts = Date.now()) {
    const wd = getSeoulWeekday(ts);
    const p = getSeoulParts(ts);
    if (wd === 6) return (p.hour < 10) ? 7 : 0;
    if (wd === 0) return 1;
    return wd + 1;
  }

  function getLatestPassedSaturday10Ms(ts = Date.now()) {
    const back = daysBackToSaturday(ts);
    const satTs = addSeoulDays(ts, -back);
    const sat = getSeoulParts(satTs);
    return seoulWallTimeToMs(sat.year, sat.month, sat.day, 10, 0);
  }

  function getNextSaturday10Ms(ts = Date.now()) {
    const wd = getSeoulWeekday(ts);
    const p = getSeoulParts(ts);
    let forward;
    if (wd === 6) {
      forward = (p.hour < 10) ? 0 : 7;
    } else if (wd === 0) {
      forward = 6;
    } else {
      forward = 6 - wd;
    }
    const satTs = addSeoulDays(ts, forward);
    const sat = getSeoulParts(satTs);
    return seoulWallTimeToMs(sat.year, sat.month, sat.day, 10, 0);
  }

  function getWorkWeekMondayKey(ts = Date.now()) {
    const wd = getSeoulWeekday(ts);
    const p = getSeoulParts(ts);
    if (wd === 0) return null;
    if (wd === 6 && p.hour >= 10) return null;
    const backToMon = wd === 6 ? 5 : (wd - 1);
    const monTs = addSeoulDays(ts, -backToMon);
    const mon = getSeoulParts(monTs);
    return `${mon.year}-${String(mon.month).padStart(2, '0')}-${String(mon.day).padStart(2, '0')}`;
  }

  function isWorkdayForRecording(ts = Date.now()) {
    const wd = getSeoulWeekday(ts);
    return wd >= 1 && wd <= 5;
  }

  function shouldRunWeeklyReset(lastResetAt, ts = Date.now()) {
    const boundary = getLatestPassedSaturday10Ms(ts);
    if (!boundary || ts < boundary) return false;
    return !lastResetAt || lastResetAt < boundary;
  }

  function filterActiveRecords(rows, ts = Date.now()) {
    const list = Array.isArray(rows) ? rows : [];
    const boundary = getLatestPassedSaturday10Ms(ts);
    return list.filter((r) => Number(r.createdAt || 0) >= boundary);
  }

  window.WeekHistory = {
    getSeoulParts,
    getSeoulWeekday,
    getLatestPassedSaturday10Ms,
    getNextSaturday10Ms,
    getWorkWeekMondayKey,
    isWorkdayForRecording,
    shouldRunWeeklyReset,
    filterActiveRecords,
  };
})();
