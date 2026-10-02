/**
 * Voting module — 식사와 무관한 자유 투표 (예: 음료수 내기, 회식 장소 등).
 *
 * 모든 식사 탭이 같은 투표 하나를 공유합니다. 저장 키는 VOTE_KEY('general').
 *
 * Vote object shape:
 *   {
 *     id: string,
 *     title: string,
 *     description: string,
 *     options: [{ id, label }],
 *     multi: boolean,          // 복수 선택 허용
 *     anonymous: boolean,      // 익명 (누가 무엇을 골랐는지 숨김)
 *     participants: string[],  // 투표 참여 인원 (등록된 대상자 이름)
 *     ballots: { [voterName]: optionId[] },
 *     createdAt, startAt, endAt, updatedAt: number (ms)
 *   }
 *
 * 참여 인원만 투표할 수 있으며, 투표 진행 중에는 표를 바꿀 수 있습니다.
 * 종료된 투표는 종료 다음날 09:30(서울)에 자동으로 기록 보관 후 정리됩니다.
 */
(function () {
  const VOTE_KEY = 'general';
  const MAX_OPTIONS = 10;

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  function cleanNames(list) {
    return Array.isArray(list)
      ? [...new Set(list.map((n) => String(n || '').trim()).filter(Boolean))]
      : [];
  }

  function getSeoulDateParts(ts) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ts));
    const year = Number(parts.find((p) => p.type === 'year')?.value || 0);
    const month = Number(parts.find((p) => p.type === 'month')?.value || 1);
    const day = Number(parts.find((p) => p.type === 'day')?.value || 1);
    return { year, month, day };
  }

  // 서울시간 "투표 종료일 다음날 09:30" = UTC 기준 다음날 00:30
  function getArchiveAtMs(vote) {
    if (!vote || !vote.endAt) return 0;
    const { year, month, day } = getSeoulDateParts(vote.endAt);
    return Date.UTC(year, month - 1, day + 1, 0, 30, 0, 0);
  }

  function tally(vote) {
    const options = Array.isArray(vote && vote.options) ? vote.options : [];
    const ballots = (vote && vote.ballots) || {};
    const scores = options.map((o) => ({ id: o.id, label: o.label, count: 0, voters: [] }));
    const byId = new Map(scores.map((s) => [s.id, s]));
    Object.entries(ballots).forEach(([name, ids]) => {
      (Array.isArray(ids) ? ids : []).forEach((id) => {
        const s = byId.get(id);
        if (s) { s.count += 1; s.voters.push(name); }
      });
    });
    const top = scores.reduce((m, s) => Math.max(m, s.count), 0);
    const winners = top > 0 ? scores.filter((s) => s.count === top) : [];
    return { scores, winners, voterCount: Object.keys(ballots).length };
  }

  function buildHistoryRecord(vote, reason) {
    const { scores, winners, voterCount } = tally(vote);
    return {
      id: vote.id,
      title: vote.title || '',
      createdAt: vote.createdAt || null,
      startAt: vote.startAt || null,
      endAt: vote.endAt || null,
      archivedAt: Date.now(),
      reason: reason || 'manual',
      multi: Boolean(vote.multi),
      anonymous: Boolean(vote.anonymous),
      participantCount: cleanNames(vote.participants).length,
      voterCount,
      winners: winners.map((w) => ({ id: w.id, label: w.label, count: w.count })),
      scores: scores.map((s) => ({
        id: s.id,
        label: s.label,
        count: s.count,
        voters: vote.anonymous ? [] : s.voters,
      })),
    };
  }

  const Voting = {
    current: null,
    history: [],

    async load() {
      const local = this.current;
      const remote = await window.Storage.getVote(VOTE_KEY);
      const localFresh = local
        && local._clientUpdatedAt
        && (Date.now() - local._clientUpdatedAt < 8000);
      if (remote && remote.options) {
        this.current = remote;
      } else if (!local || !localFresh) {
        this.current = null;
      }
      await this.maybeAutoArchive();
      return this.current;
    },

    get() {
      return this.current;
    },

    async create({ title, description, options, multi, anonymous, participants, startAt, endAt }) {
      const cleanTitle = String(title || '').trim();
      if (!cleanTitle) throw new Error('투표 제목을 입력해주세요.');
      const labels = [...new Set((options || []).map((o) => String(o || '').trim()).filter(Boolean))];
      if (labels.length < 2) throw new Error('선택지는 서로 다른 내용으로 2개 이상 입력해주세요.');
      if (labels.length > MAX_OPTIONS) throw new Error(`선택지는 최대 ${MAX_OPTIONS}개까지 가능합니다.`);
      const people = cleanNames(participants);
      if (!people.length) throw new Error('참여 인원을 1명 이상 선택해주세요.');
      if (!startAt || !endAt || endAt <= startAt) {
        throw new Error('투표 종료 시간은 시작 시간보다 이후여야 합니다.');
      }
      if (endAt <= Date.now()) throw new Error('투표 종료 시간이 이미 지났습니다.');

      const vote = {
        id: uid('v'),
        title: cleanTitle,
        description: String(description || '').trim(),
        options: labels.map((label) => ({ id: uid('o'), label })),
        multi: Boolean(multi),
        anonymous: Boolean(anonymous),
        participants: people,
        ballots: {},
        createdAt: Date.now(),
        startAt,
        endAt,
        updatedAt: Date.now(),
      };
      vote._clientUpdatedAt = Date.now();
      this.current = vote;
      await window.Storage.saveVote(VOTE_KEY, vote);
      return vote;
    },

    // 동시 수정 충돌을 줄이기 위해 저장 직전 최신 상태를 다시 읽고 변경을 적용
    async mutate(fn) {
      const vote = await window.Storage.getVote(VOTE_KEY);
      if (!vote || !vote.options) {
        this.current = null;
        throw new Error('진행 중인 투표가 없습니다.');
      }
      if (!vote.ballots || typeof vote.ballots !== 'object') vote.ballots = {};
      vote.participants = cleanNames(vote.participants);
      fn(vote);
      vote.updatedAt = Date.now();
      vote._clientUpdatedAt = Date.now();
      await window.Storage.saveVote(VOTE_KEY, vote);
      this.current = vote;
      return vote;
    },

    async cast(voterName, optionIds) {
      const name = String(voterName || '').trim();
      if (!name) throw new Error('투표자를 선택해주세요.');
      const ids = [...new Set(Array.isArray(optionIds) ? optionIds : [optionIds])].filter(Boolean);
      if (!ids.length) throw new Error('선택지를 골라주세요.');
      return this.mutate((vote) => {
        const status = this.status(vote);
        if (status === 'pending') throw new Error('아직 투표 시작 시간이 아닙니다.');
        if (status === 'ended') throw new Error('투표가 이미 종료되었습니다.');
        if (!vote.participants.includes(name)) throw new Error('참여 인원이 아닙니다. 먼저 참여로 이동해주세요.');
        if (!vote.multi && ids.length > 1) throw new Error('하나만 선택할 수 있는 투표입니다.');
        const valid = new Set(vote.options.map((o) => o.id));
        if (ids.some((id) => !valid.has(id))) throw new Error('존재하지 않는 선택지입니다.');
        vote.ballots[name] = ids;
      });
    },

    async setParticipants(names, joined) {
      const targets = cleanNames(names);
      return this.mutate((vote) => {
        if (this.status(vote) === 'ended') throw new Error('종료된 투표는 참여 인원을 바꿀 수 없습니다.');
        const set = new Set(vote.participants);
        targets.forEach((name) => {
          if (joined) {
            set.add(name);
          } else {
            set.delete(name);
            delete vote.ballots[name];
          }
        });
        vote.participants = [...set];
      });
    },

    async clear(reason) {
      const existing = this.current || await window.Storage.getVote(VOTE_KEY);
      if (existing && existing.options && typeof window.Storage.saveVoteHistory === 'function') {
        await window.Storage.saveVoteHistory(VOTE_KEY, buildHistoryRecord(existing, reason));
      }
      this.current = null;
      await window.Storage.clearVote(VOTE_KEY);
    },

    async maybeAutoArchive() {
      const vote = this.current;
      if (!vote) return false;
      const archiveAt = getArchiveAtMs(vote);
      if (!archiveAt || Date.now() < archiveAt) return false;
      await this.clear('auto-next-day-0930');
      return true;
    },

    async loadHistory() {
      if (window.Storage && typeof window.Storage.getVoteHistory === 'function') {
        const rows = await window.Storage.getVoteHistory(VOTE_KEY);
        this.history = Array.isArray(rows) ? rows : [];
      } else {
        this.history = [];
      }
      return this.history;
    },

    getHistory() {
      return this.history;
    },

    async clearHistory() {
      if (window.Storage && typeof window.Storage.clearVoteHistory === 'function') {
        await window.Storage.clearVoteHistory(VOTE_KEY);
      }
      this.history = [];
    },

    status(vote) {
      if (!vote) return 'none';
      const now = Date.now();
      if (now < vote.startAt) return 'pending';
      if (now > vote.endAt)   return 'ended';
      return 'open';
    },

    tally,
    MAX_OPTIONS,
  };

  window.Voting = Voting;
})();
