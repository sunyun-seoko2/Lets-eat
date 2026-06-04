/**
 * Voting module.
 * Vote object shape:
 *   {
 *     id: string,
 *     meal: string,
 *     createdAt: number (ms),
 *     candidates: [{ id, name }],
 *     voters: string[],
 *     votedPeople: string[],
 *     startAt: number (ms),
 *     endAt: number (ms),
 *     votes: { [candidateId]: [voterName] }  // 한 후보당 투표자 이름 목록
 *   }
 *
 * 같은 이름은 한 투표 내에서 1회만 투표 가능 (간단한 중복 방지).
 */
(function () {
  function uid() {
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  function ensureMealCurrent(current, meal) {
    if (!(meal in current)) current[meal] = null;
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

  // 서울시간 "투표 생성일 다음날 09:30" = UTC 기준 다음날 00:30
  function getResetAtMs(vote) {
    if (!vote) return 0;
    const baseTs = vote.createdAt || vote.startAt || vote.endAt || Date.now();
    const { year, month, day } = getSeoulDateParts(baseTs);
    return Date.UTC(year, month - 1, day + 1, 0, 30, 0, 0);
  }

  function buildHistoryRecord(vote, reason) {
    const candidates = Array.isArray(vote.candidates) ? vote.candidates : [];
    const scores = candidates.map((c) => {
      const voters = Array.isArray(vote.votes && vote.votes[c.id]) ? vote.votes[c.id] : [];
      return { id: c.id, name: c.name, count: voters.length, voters: [...voters] };
    });
    scores.sort((a, b) => b.count - a.count);
    const top = scores[0] ? scores[0].count : 0;
    const winners = scores.filter((s) => s.count === top && top > 0).map((s) => ({
      id: s.id,
      name: s.name,
      count: s.count,
    }));
    return {
      id: vote.id,
      meal: vote.meal,
      createdAt: vote.createdAt || null,
      startAt: vote.startAt || null,
      endAt: vote.endAt || null,
      archivedAt: Date.now(),
      reason: reason || 'manual',
      winners,
      scores,
    };
  }

  const Voting = {
    current: {},
    history: {},

    async load(meal) {
      ensureMealCurrent(this.current, meal);
      const local = this.current[meal];
      const remote = await window.Storage.getVote(meal);
      const localFresh = local
        && local._clientUpdatedAt
        && (Date.now() - local._clientUpdatedAt < 8000);
      if (remote) {
        this.current[meal] = remote;
      } else if (!local || !localFresh) {
        this.current[meal] = null;
      }
      await this.maybeAutoReset(meal);
      return this.current[meal];
    },

    get(meal) {
      ensureMealCurrent(this.current, meal);
      return this.current[meal];
    },

    async create(meal, candidates, startAt, endAt, voters) {
      ensureMealCurrent(this.current, meal);
      if (!candidates || candidates.length < 2) {
        throw new Error('후보는 최소 2개 이상이어야 합니다.');
      }
      if (!startAt || !endAt || endAt <= startAt) {
        throw new Error('투표 종료 시간은 시작 시간보다 이후여야 합니다.');
      }
      const vote = {
        id: uid(),
        meal,
        createdAt: Date.now(),
        candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
        voters: Array.isArray(voters) ? [...new Set(voters.map((n) => String(n || '').trim()).filter(Boolean))] : [],
        votedPeople: [],
        startAt,
        endAt,
        votes: Object.fromEntries(candidates.map((c) => [c.id, []])),
      };
      vote._clientUpdatedAt = Date.now();
      this.current[meal] = vote;
      await window.Storage.saveVote(meal, vote);
      return vote;
    },

    async cast(meal, candidateId, voterName) {
      ensureMealCurrent(this.current, meal);
      const name = (voterName || '').trim();
      if (!name) throw new Error('투표자 이름을 입력해주세요.');

      // 동시 투표 충돌을 줄이기 위해 저장 직전 최신 상태를 다시 읽음
      const vote = await window.Storage.getVote(meal);
      if (!vote) {
        this.current[meal] = null;
        throw new Error('진행 중인 투표가 없습니다.');
      }
      this.current[meal] = vote;
      if (!Array.isArray(vote.votedPeople)) {
        vote.votedPeople = Array.from(
          new Set(
            Object.values(vote.votes || {})
              .flatMap((list) => (Array.isArray(list) ? list : []))
              .map((name) => String(name || '').trim())
              .filter(Boolean)
          )
        );
      }

      const now = Date.now();
      if (now < vote.startAt) throw new Error('아직 투표 시작 시간이 아닙니다.');
      if (now > vote.endAt)   throw new Error('투표가 이미 종료되었습니다.');
      const allowedVoters = Array.isArray(vote.voters) ? vote.voters : [];
      if (allowedVoters.length && !allowedVoters.includes(name)) {
        throw new Error('투표 대상자 목록에 없는 이름입니다.');
      }

      const already = Object.values(vote.votes).some((list) => list.includes(name));
      if (already) throw new Error('이미 투표하셨습니다. (이름 기준 1회 제한)');

      if (!vote.votes[candidateId]) vote.votes[candidateId] = [];
      vote.votes[candidateId].push(name);
      if (!vote.votedPeople.includes(name)) vote.votedPeople.push(name);
      vote._clientUpdatedAt = Date.now();
      await window.Storage.saveVote(meal, vote);
      this.current[meal] = vote;
      return vote;
    },

    async clear(meal) {
      ensureMealCurrent(this.current, meal);
      const existing = this.current[meal] || await window.Storage.getVote(meal);
      if (existing && (!window.WeekHistory || window.WeekHistory.isWorkdayForRecording())) {
        const historyRecord = buildHistoryRecord(existing, 'manual');
        if (window.Storage && typeof window.Storage.saveVoteHistory === 'function') {
          await window.Storage.saveVoteHistory(meal, historyRecord);
        }
      }
      this.current[meal] = null;
      await window.Storage.clearVote(meal);
    },

    async maybeAutoReset(meal) {
      ensureMealCurrent(this.current, meal);
      const vote = this.current[meal];
      if (!vote) return false;
      const resetAt = getResetAtMs(vote);
      if (!resetAt || Date.now() < resetAt) return false;
      if (window.WeekHistory && window.WeekHistory.isWorkdayForRecording()) {
        const historyRecord = buildHistoryRecord(vote, 'auto-next-day-0930');
        if (window.Storage && typeof window.Storage.saveVoteHistory === 'function') {
          await window.Storage.saveVoteHistory(meal, historyRecord);
        }
      }
      await window.Storage.clearVote(meal);
      this.current[meal] = null;
      return true;
    },

    async loadHistory(meal) {
      if (!(meal in this.history)) this.history[meal] = [];
      if (window.Storage && typeof window.Storage.getVoteHistory === 'function') {
        const rows = await window.Storage.getVoteHistory(meal);
        this.history[meal] = window.WeekHistory
          ? window.WeekHistory.filterActiveRecords(rows)
          : rows;
      } else {
        this.history[meal] = [];
      }
      return this.history[meal];
    },

    getHistory(meal) {
      if (!(meal in this.history)) this.history[meal] = [];
      return this.history[meal];
    },

    async clearHistory(meal) {
      if (window.Storage && typeof window.Storage.clearVoteHistory === 'function') {
        await window.Storage.clearVoteHistory(meal);
      } else if (window.Storage && typeof window.Storage.deleteVoteHistory === 'function') {
        const rows = await this.loadHistory(meal);
        await Promise.all(
          rows.map((row) => window.Storage.deleteVoteHistory(meal, row.id))
        );
      }
      this.history[meal] = [];
    },

    status(vote) {
      if (!vote) return 'none';
      const now = Date.now();
      if (now < vote.startAt) return 'pending';
      if (now > vote.endAt)   return 'ended';
      return 'open';
    },
  };

  window.Voting = Voting;
})();
