/**
 * 당첨 기록 규칙 (서울 시간)
 * - 오늘 + 직전 3업무일(월~금, 주말 건너뜀)에 당첨된 가게를 랜덤 후보에서 제외
 * - 새 당첨 기록을 남길 때 7일보다 오래된 기록 정리
 */
(function () {
  const TZ = 'Asia/Seoul';
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RECENT_WORKDAYS = 3;
  const PRUNE_AFTER_MS = 7 * DAY_MS;

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

  function isWorkday(ts = Date.now()) {
    const wd = getSeoulWeekday(ts);
    return wd >= 1 && wd <= 5;
  }

  function dateKeyOf(ts) {
    const p = getSeoulParts(ts);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }

  // 서울 날짜의 정오 (하루 단위로 앞뒤로 옮길 때 기준점)
  function seoulNoonMs(ts) {
    const p = getSeoulParts(ts);
    return seoulWallTimeToMs(p.year, p.month, p.day, 12, 0);
  }

  /** 오늘 + 직전 n업무일의 날짜 키 (YYYY-MM-DD) */
  function getRecentWorkdayKeys(ts = Date.now(), n = RECENT_WORKDAYS) {
    let cur = seoulNoonMs(ts);
    const keys = new Set([dateKeyOf(cur)]);
    let count = 0;
    while (count < n) {
      cur -= DAY_MS;
      if (isWorkday(cur)) {
        keys.add(dateKeyOf(cur));
        count += 1;
      }
    }
    return keys;
  }

  /** 기록이 마지막으로 후보 제외에 쓰이는 업무일 (기록일 + n업무일) */
  function getBlockedUntilMs(createdAt, n = RECENT_WORKDAYS) {
    let cur = seoulNoonMs(createdAt);
    let count = 0;
    while (count < n) {
      cur += DAY_MS;
      if (isWorkday(cur)) count += 1;
    }
    return cur;
  }

  function filterActiveRecords(rows, ts = Date.now()) {
    const list = Array.isArray(rows) ? rows : [];
    const keys = getRecentWorkdayKeys(ts);
    return list.filter((r) => keys.has(dateKeyOf(Number(r.createdAt || 0))));
  }

  function isPrunableRecord(row, ts = Date.now()) {
    return Number((row && row.createdAt) || 0) < ts - PRUNE_AFTER_MS;
  }

  window.WeekHistory = {
    RECENT_WORKDAYS,
    getSeoulParts,
    getSeoulWeekday,
    isWorkday,
    getRecentWorkdayKeys,
    getBlockedUntilMs,
    filterActiveRecords,
    isPrunableRecord,
  };
})();
