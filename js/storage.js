/**
 * Storage adapter (localStorage based).
 *
 * 추후 Azure Table Storage 등 원격 저장소로 바꾸려면 아래 인터페이스만 동일하게
 * 구현한 어댑터를 만들어서 window.Storage 로 노출하면 됩니다.
 *   - getStores(meal): Promise<Store[]>
 *   - saveStores(meal, stores): Promise<void>
 *   - getVote(meal): Promise<Vote|null>
 *   - saveVote(meal, vote): Promise<void>
 *   - clearVote(meal): Promise<void>
 *
 * Azure Table Storage 어댑터 예시는 README.md 참고.
 */
(function () {
  const KEY_STORES = (meal) => `ls.stores.${meal}`;
  const KEY_VOTE   = (meal) => `ls.vote.${meal}`;
  const KEY_VOTE_HISTORY = (meal) => `ls.vote.history.${meal}`;
  const KEY_ROULETTE = (meal) => `ls.roulette.${meal}`;
  const KEY_RANDOM_HISTORY = (meal) => `ls.random.history.${meal}`;
  const KEY_PEOPLE = 'ls.people.v1';
  const KEY_CAUTION = 'ls.cautions.v1';
  const KEY_ASSIGN = 'ls.assignments.v1';
  const KEY_ASSIGNMENT_PINS = 'ls.assignmentPins.v1';
  const KEY_ASSIGN_RESET = 'ls.assignments.reset.date.v1';
  const KEY_ASSIGN_RESET_SCHEDULE = 'ls.assignments.reset.schedule.v1';
  const KEY_PEOPLE_BUNDLE = 'ls.people.bundle.v1';
  const KEY_WEEKLY_RESET = 'ls.weeklyReset.at';

  function safeParse(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  const Storage = {
    async getStores(meal) {
      return safeParse(localStorage.getItem(KEY_STORES(meal)), []);
    },
    async saveStores(meal, stores) {
      localStorage.setItem(KEY_STORES(meal), JSON.stringify(stores));
    },
    async getVote(meal) {
      return safeParse(localStorage.getItem(KEY_VOTE(meal)), null);
    },
    async saveVote(meal, vote) {
      localStorage.setItem(KEY_VOTE(meal), JSON.stringify(vote));
    },
    async clearVote(meal) {
      localStorage.removeItem(KEY_VOTE(meal));
    },
    async getRoulette(meal) {
      return safeParse(localStorage.getItem(KEY_ROULETTE(meal)), null);
    },
    async saveRoulette(meal, roulette) {
      localStorage.setItem(KEY_ROULETTE(meal), JSON.stringify(roulette));
    },
    async clearRoulette(meal) {
      localStorage.removeItem(KEY_ROULETTE(meal));
    },
    async getVoteHistory(meal) {
      const rows = safeParse(localStorage.getItem(KEY_VOTE_HISTORY(meal)), []);
      return Array.isArray(rows) ? rows : [];
    },
    async saveVoteHistory(meal, record) {
      const rows = await this.getVoteHistory(meal);
      rows.push(record);
      localStorage.setItem(KEY_VOTE_HISTORY(meal), JSON.stringify(rows));
    },
    async deleteVoteHistory(meal, recordId) {
      const rows = await this.getVoteHistory(meal);
      localStorage.setItem(
        KEY_VOTE_HISTORY(meal),
        JSON.stringify(rows.filter((r) => String(r.id) !== String(recordId)))
      );
    },
    async clearVoteHistory(meal) {
      localStorage.setItem(KEY_VOTE_HISTORY(meal), JSON.stringify([]));
    },
    async getRandomHistory(meal) {
      const rows = safeParse(localStorage.getItem(KEY_RANDOM_HISTORY(meal)), []);
      return Array.isArray(rows) ? rows : [];
    },
    async saveRandomHistory(meal, record) {
      const rows = await this.getRandomHistory(meal);
      rows.push(record);
      localStorage.setItem(KEY_RANDOM_HISTORY(meal), JSON.stringify(rows));
    },
    async deleteRandomHistory(meal, recordId) {
      const rows = await this.getRandomHistory(meal);
      localStorage.setItem(
        KEY_RANDOM_HISTORY(meal),
        JSON.stringify(rows.filter((r) => String(r.id) !== String(recordId)))
      );
    },
    async clearRandomHistory(meal) {
      localStorage.removeItem(KEY_RANDOM_HISTORY(meal));
    },
    async getWeeklyResetAt() {
      const raw = localStorage.getItem(KEY_WEEKLY_RESET);
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    },
    async setWeeklyResetAt(ts) {
      localStorage.setItem(KEY_WEEKLY_RESET, String(Number(ts) || 0));
    },
    async getPeopleBundle() {
      const bundle = safeParse(localStorage.getItem(KEY_PEOPLE_BUNDLE), null);
      if (bundle && typeof bundle === 'object') return bundle;
      return {
        people: safeParse(localStorage.getItem(KEY_PEOPLE), []),
        cautions: safeParse(localStorage.getItem(KEY_CAUTION), []),
        assignments: safeParse(localStorage.getItem(KEY_ASSIGN), { outside: [], lunchbox: [] }),
        assignmentPins: safeParse(localStorage.getItem(KEY_ASSIGNMENT_PINS), {}),
        resetState: safeParse(localStorage.getItem(KEY_ASSIGN_RESET_SCHEDULE), null),
        resetDate: localStorage.getItem(KEY_ASSIGN_RESET) || '',
      };
    },
    async savePeopleBundle(bundle) {
      const safe = (bundle && typeof bundle === 'object') ? bundle : {};
      localStorage.setItem(KEY_PEOPLE_BUNDLE, JSON.stringify(safe));
      localStorage.setItem(KEY_PEOPLE, JSON.stringify(safe.people || []));
      localStorage.setItem(KEY_CAUTION, JSON.stringify(safe.cautions || []));
      localStorage.setItem(KEY_ASSIGN, JSON.stringify(safe.assignments || { outside: [], lunchbox: [] }));
      localStorage.setItem(KEY_ASSIGNMENT_PINS, JSON.stringify(safe.assignmentPins || {}));
      localStorage.setItem(KEY_ASSIGN_RESET_SCHEDULE, JSON.stringify(safe.resetState || null));
      localStorage.setItem(KEY_ASSIGN_RESET, safe.resetDate || '');
    },
  };

  window.Storage = Storage;
})();
