/**
 * Teams Workflows 웹후크로 Adaptive Card 전송.
 * TEAMS_WEBHOOK_URL 은 Function 앱 설정에만 둔다 (클라이언트 코드/저장소에 넣지 말 것).
 */
const KO_WEEKDAYS = { Sun: '일요일', Mon: '월요일', Tue: '화요일', Wed: '수요일', Thu: '목요일', Fri: '금요일', Sat: '토요일' };
const DEFAULT_BANNER_URL = 'https://sunyun-seoko2.github.io/Lets-eat/assets/teams-banner.jpg';

function isHttpUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 버튼 링크로 쓸 수 있는 URL(http/https, 공백 없음)이면 trim 한 값, 아니면 null */
function linkUrl(value) {
  if (!isHttpUrl(value)) return null;
  const s = String(value).trim();
  return /\s/.test(s) ? null : s;
}

function titleText(parts) {
  return `${parts.year}년 ${parts.month}월 ${parts.day}일 ${KO_WEEKDAYS[parts.weekday] || ''} 점심 룰렛 결과`;
}

function bannerBlock() {
  const url = String(process.env.TEAMS_BANNER_URL || DEFAULT_BANNER_URL).trim();
  if (!isHttpUrl(url)) return null;
  return { type: 'Image', url, size: 'Stretch', altText: '밥먹자 배너' };
}

function titleBlock(parts) {
  return {
    type: 'TextBlock',
    text: titleText(parts),
    horizontalAlignment: 'Center',
    weight: 'Bolder',
    wrap: true,
    spacing: 'Medium',
  };
}

function buildCard({ parts, winnerName, store }) {
  const name = winnerName || '';
  const storeUrl = store ? linkUrl(store.url) : null;
  return wrapCard([
    bannerBlock(),
    titleBlock(parts),
    {
      type: 'TextBlock',
      text: `🗺️ ${name}`,
      horizontalAlignment: 'Center',
      size: 'ExtraLarge',
      weight: 'Bolder',
      wrap: true,
    },
    // Teams 는 ActionSet 버튼을 왼쪽에 붙이므로, 좌우 빈 칸(stretch) 사이에 두어 가운데 정렬
    storeUrl ? {
      type: 'ColumnSet',
      spacing: 'Medium',
      columns: [
        { type: 'Column', width: 'stretch', items: [] },
        {
          type: 'Column',
          width: 'auto',
          items: [{
            type: 'ActionSet',
            actions: [{ type: 'Action.OpenUrl', title: '네이버 지도에서 보기', url: storeUrl, style: 'positive' }],
          }],
        },
        { type: 'Column', width: 'stretch', items: [] },
      ],
    } : null,
  ]);
}

function buildInsufficientCard({ parts, note }) {
  return wrapCard([
    bannerBlock(),
    titleBlock(parts),
    { type: 'TextBlock', text: String(note || ''), horizontalAlignment: 'Center', wrap: true, spacing: 'Medium' },
  ]);
}

function wrapCard(body) {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: body.filter(Boolean),
  };
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
