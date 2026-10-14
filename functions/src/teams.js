/**
 * Teams Workflows 웹후크로 Adaptive Card 전송.
 * TEAMS_WEBHOOK_URL 은 Function 앱 설정에만 둔다 (클라이언트 코드/저장소에 넣지 말 것).
 */
const KO_WEEKDAYS = { Sun: '일', Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토' };

function formatMeters(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

function headerText(parts, meal) {
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `${parts.year}. ${p2(parts.month)}. ${p2(parts.day)}.(${KO_WEEKDAYS[parts.weekday] || ''})`;
  return `🎯 오늘의 ${meal === 'fridayLunch' ? '금요일 점심' : '점심'} 룰렛 · ${date}`;
}

function headerBlock(parts, meal) {
  return {
    type: 'TextBlock',
    text: headerText(parts, meal),
    size: 'Small',
    isSubtle: true,
    wrap: true,
  };
}

function buildCard({ parts, meal, winnerName, store, walk, candidateNames }) {
  const facts = [];
  if (store && store.address) facts.push({ title: '주소', value: String(store.address) });
  if (walk) facts.push({ title: '도보', value: `약 ${walk.minutes}분 (약 ${formatMeters(walk.walkM)})` });
  if (store && store.memo) facts.push({ title: '메모', value: String(store.memo) });
  if (candidateNames && candidateNames.length) facts.push({ title: '후보', value: candidateNames.join(' · ') });

  const body = [
    headerBlock(parts, meal),
    {
      type: 'TextBlock',
      text: String(winnerName || ''),
      size: 'Large',
      weight: 'Bolder',
      color: 'Accent',
      wrap: true,
    },
  ];
  if (facts.length) body.push({ type: 'FactSet', facts });

  const actions = [];
  if (store && isHttpUrl(store.url)) {
    actions.push({ type: 'Action.OpenUrl', title: '네이버 지도에서 보기', url: String(store.url).trim() });
  }
  if (isHttpUrl(process.env.APP_URL)) {
    actions.push({ type: 'Action.OpenUrl', title: '밥먹자 열기', url: process.env.APP_URL.trim() });
  }
  return wrapCard(body, actions);
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildInsufficientCard({ parts, meal, note }) {
  return wrapCard([
    headerBlock(parts, meal),
    { type: 'TextBlock', text: String(note || ''), wrap: true },
  ], isHttpUrl(process.env.APP_URL)
    ? [{ type: 'Action.OpenUrl', title: '밥먹자 열기', url: process.env.APP_URL.trim() }]
    : []);
}

function wrapCard(body, actions) {
  const content = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body,
  };
  if (actions.length) content.actions = actions;
  return content;
}

/** 실패 시 예외를 던지지 않고 false 반환 (로그는 context.error) */
async function postCard(card, context) {
  const url = process.env.TEAMS_WEBHOOK_URL;
  if (!url) {
    context.warn('TEAMS_WEBHOOK_URL 이 설정되지 않아 Teams 알림을 건너뜁니다.');
    return false;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: card,
        }],
      }),
    });
    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch { /* ignore */ }
      context.error(`Teams 전송 실패: ${res.status} ${text.slice(0, 500)}`);
      return false;
    }
    context.log(`Teams 전송 완료 (${res.status})`);
    return true;
  } catch (e) {
    context.error('Teams 전송 오류:', e && e.message ? e.message : e);
    return false;
  }
}

module.exports = { buildCard, buildInsufficientCard, postCard };
