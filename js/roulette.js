/**
 * Roulette — canvas-based spinning wheel.
 * - 기본 랜덤 후보(최대 5개) + 선택 룰렛(최대 10개)
 * - 외부에서 지정한 winnerId/startAt/duration으로 동기화 재생 가능
 */
(function () {
  const COLORS = ['#5b6cff', '#ff9f43', '#10b981', '#ef4444', '#a855f7', '#f59e0b', '#06b6d4'];
  const DEFAULT_DURATION = 4200;
  const MIN_ITEMS = 2;
  const MAX_ITEMS = 10;

  const Roulette = {
    canvas: null,
    ctx: null,
    items: [],
    rotation: 0,
    spinning: false,
    onResult: null,
    spinSessionId: '',
    itemSignature: '',

    init(canvasId) {
      this.canvas = document.getElementById(canvasId);
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext('2d');
      this.draw();
    },

    setItems(items, options = {}) {
      const safe = Array.isArray(items) ? items.filter((it) => it && it.id && it.name) : [];
      const nextItems = safe.slice(0, MAX_ITEMS);
      const nextSignature = getItemsSignature(nextItems);
      const preserveRotation = Boolean(options.preserveRotation && nextSignature === this.itemSignature);
      this.items = nextItems;
      this.itemSignature = nextSignature;
      if (!preserveRotation) {
        this.rotation = 0;
        this.spinning = false;
        this.spinSessionId = '';
      }
      this.draw();
    },

    getItemsSignature(items = this.items) {
      return getItemsSignature(items);
    },

    draw() {
      if (!this.ctx) return;
      const ctx = this.ctx;
      const W = this.canvas.width;
      const H = this.canvas.height;
      const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 8;
      ctx.clearRect(0, 0, W, H);

      if (this.items.length === 0) {
        ctx.fillStyle = '#eef0ff';
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#888';
        ctx.font = '700 16px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('“랜덤/선택 룰렛” 버튼으로 후보를 준비하세요', cx, cy);
        return;
      }

      const n = this.items.length;
      const seg = (Math.PI * 2) / n;

      for (let i = 0; i < n; i++) {
        const start = this.rotation + i * seg;
        const end = start + seg;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, start, end);
        ctx.closePath();
        ctx.fillStyle = COLORS[i % COLORS.length];
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // label — 슬라이스 중앙, 길면 최대 2줄
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(start + seg / 2);
        const labelR = r * 0.58;
        const fontSize = Math.max(12, Math.min(17, Math.floor(seg * labelR * 0.9)));
        const maxTextWidth = Math.min(seg * labelR * 1.2, r * 0.52);
        drawSliceLabel(ctx, this.items[i].name, labelR, fontSize, maxTextWidth);
        ctx.restore();
      }

      // hub
      ctx.beginPath();
      ctx.arc(cx, cy, 18, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#5b6cff';
      ctx.lineWidth = 3;
      ctx.stroke();
    },

    getWinnerById(winnerId) {
      if (!winnerId) return null;
      return this.items.find((it) => String(it.id) === String(winnerId)) || null;
    },

    getDisplayWinner(session) {
      const winner = this.resolveWinner(session);
      if (winner && winner.name) return winner.name;
      return String((session && session.winnerName) || '가게');
    },

    getPointerWinner() {
      if (!this.items.length) return null;
      const n = this.items.length;
      const seg = (Math.PI * 2) / n;
      const pointerAngle = normalizePositiveAngle(-Math.PI / 2 - this.rotation);
      const idx = Math.min(n - 1, Math.floor(pointerAngle / seg));
      return this.items[idx] || null;
    },

    resolveWinner(session) {
      const winnerId = session && typeof session === 'object' ? session.winnerId : session;
      return this.getWinnerById(winnerId);
    },

    settle(session) {
      if (!session || !session.winnerId || !Array.isArray(this.items) || this.items.length < MIN_ITEMS) return null;
      const winnerIndex = this.items.findIndex((it) => String(it.id) === String(session.winnerId));
      if (winnerIndex < 0) return null;
      const n = this.items.length;
      const seg = (Math.PI * 2) / n;
      this.rotation = getTargetRotation(winnerIndex, seg);
      this.spinning = false;
      this.spinSessionId = String(session.id || `${session.winnerId}:${session.startAt || 0}:${session.durationMs || DEFAULT_DURATION}`);
      this.draw();
      return this.items[winnerIndex];
    },

    spin(onResult) {
      if (this.spinning || this.items.length < MIN_ITEMS) return null;
      const winner = this.items[Math.floor(Math.random() * this.items.length)];
      const session = {
        id: `rs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        winnerId: winner.id,
        startAt: Date.now(),
        durationMs: DEFAULT_DURATION,
      };
      this.play(session, onResult);
      return session;
    },

    play(session, onResult) {
      if (!session || !session.winnerId || !Array.isArray(this.items) || this.items.length < MIN_ITEMS) return;
      const winner = this.getWinnerById(session.winnerId);
      if (!winner) return;
      const duration = Math.max(1000, Number(session.durationMs) || DEFAULT_DURATION);
      const startAt = Number(session.startAt) || Date.now();
      const sessionId = String(session.id || `${session.winnerId}:${startAt}:${duration}`);
      this.spinning = true;
      this.onResult = onResult;
      this.spinSessionId = sessionId;

      const n = this.items.length;
      const seg = (Math.PI * 2) / n;
      const winnerIndex = this.items.findIndex((it) => String(it.id) === String(session.winnerId));
      if (winnerIndex < 0) {
        this.spinning = false;
        return;
      }
      // The pointer is at top center (-PI/2). We want the middle of winner segment to land there.
      const targetAngle = getTargetRotation(winnerIndex, seg);
      const fullSpins = getSpinTurns(session, sessionId);
      const finalRotation = targetAngle - fullSpins * Math.PI * 2;
      const rawStartRotation = Number(session.startRotation);
      const startRotation = Number.isFinite(rawStartRotation) ? rawStartRotation : this.rotation;
      const delta = finalRotation - normalizeAngle(startRotation, finalRotation);

      const animate = (now) => {
        if (this.spinSessionId !== sessionId) return;
        const elapsed = Date.now() - startAt;
        const t = Math.max(0, Math.min(1, elapsed / duration));
        const eased = easeOutCubic(t);
        this.rotation = startRotation + delta * eased;
        this.draw();
        if (t < 1) {
          requestAnimationFrame(animate);
        } else {
          this.spinning = false;
          const settledWinner = this.settle(session) || winner;
          if (this.onResult) this.onResult(settledWinner);
        }
      };
      requestAnimationFrame(animate);
    },

    __test: {
      wrapLabelLines,
    },
  };

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function wrapLabelLines(ctx, text, maxWidth, maxLines) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return [''];
    if (ctx.measureText(raw).width <= maxWidth) return [raw];

    const words = raw.split(' ').filter(Boolean);
    if (words.length > 1) {
      const lines = [];
      let current = '';
      for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (!current || ctx.measureText(next).width <= maxWidth) {
          current = next;
          continue;
        }
        lines.push(current);
        current = word;
        if (lines.length === maxLines - 1) break;
      }
      const usedText = lines.concat(current).join(' ');
      const remainder = raw.slice(usedText.length).trim();
      if (remainder) current = `${current} ${remainder}`.trim();
      if (current) lines.push(ellipsize(ctx, current, maxWidth));
      return lines.slice(0, maxLines).filter(Boolean);
    }

    return [ellipsize(ctx, raw, maxWidth)];
  }

  function drawSliceLabel(ctx, text, labelR, fontSize, maxTextWidth) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    let fittedFontSize = fontSize;
    if (raw && !raw.includes(' ')) {
      while (fittedFontSize > 11) {
        ctx.font = `800 ${fittedFontSize}px sans-serif`;
        if (ctx.measureText(raw).width <= maxTextWidth) break;
        fittedFontSize -= 1;
      }
    }
    ctx.font = `800 ${fittedFontSize}px sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wrapLabelLines(ctx, raw, maxTextWidth, 2);
    const lineHeight = fittedFontSize * 1.08;
    const startY = -((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, idx) => {
      ctx.fillText(line, labelR, startY + idx * lineHeight);
    });
  }

  function ellipsize(ctx, text, maxWidth) {
    let value = String(text || '').trim();
    if (!value || ctx.measureText(value).width <= maxWidth) return value;
    while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) {
      value = value.slice(0, -1);
    }
    return `${value}…`;
  }

  function normalizeAngle(start, target) {
    // Keep start such that target < start (so we spin in negative dir).
    while (target > start) start += Math.PI * 2;
    return start;
  }

  function normalizePositiveAngle(angle) {
    const full = Math.PI * 2;
    return ((angle % full) + full) % full;
  }

  function getTargetRotation(winnerIndex, seg) {
    return -Math.PI / 2 - (winnerIndex * seg + seg / 2);
  }

  function getItemsSignature(items) {
    return (Array.isArray(items) ? items : [])
      .map((it) => `${String(it && it.id)}:${String(it && it.name)}`)
      .join('|');
  }

  function getSpinTurns(session, sessionId) {
    const configured = Number(session && session.spinTurns);
    if (Number.isFinite(configured) && configured >= 5) return configured;
    let hash = 0;
    for (const ch of String(sessionId || '')) {
      hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    }
    return 5 + Math.abs(hash % 3);
  }

  window.Roulette = Roulette;
})();
