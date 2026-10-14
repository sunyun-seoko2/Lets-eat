/**
 * Teams Workflows 웹후크로 Adaptive Card 전송.
 * TEAMS_WEBHOOK_URL 은 Function 앱 설정에만 둔다 (클라이언트 코드/저장소에 넣지 말 것).
 */
const KO_WEEKDAYS = { Sun: '일요일', Mon: '월요일', Tue: '화요일', Wed: '수요일', Thu: '목요일', Fri: '금요일', Sat: '토요일' };
const DEFAULT_BANNER_URL = 'https://sunyun-seoko2.github.io/Lets-eat/assets/teams-banner.jpg';

function formatMeters(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 마크다운 링크로 쓸 수 있는 URL 이면 trim 한 값, 아니면 null (공백/')' 포함 시 제외) */
function linkUrl(value) {
  if (!isHttpUrl(value)) return null;
  const s = String(value).trim();
  return /[\s)]/.test(s) ? null : s;
}

function titleText(parts) {
  return `${parts.year}년 ${parts.month}월 ${parts.day}일 ${KO_WEEKDAYS[parts.weekday] || ''} 점심 룰렛 결과`;
}

function bannerBlock() {
  const url = String(process.env.TEAMS_BANNER_URL || DEFAULT_BANNER_URL).trim();
  if (!isHttpUrl(url)) return null;
  return { type: 'Image', url, width: '360px', height: '180px', horizontalAlignment: 'Center', altText: '밥먹자 배너' };
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

function linksBlock(links) {
  const items = links.filter(Boolean);
  if (!items.length) return null;
  return {
    type: 'TextBlock',
    text: items.join('  ·  '),
    horizontalAlignment: 'Center',
    wrap: true,
    spacing: 'Medium',
  };
}

function appLink() {
  const u = linkUrl(process.env.APP_URL);
  return u ? `[밥먹자 열기](${u})` : null;
}

function buildCard({ parts, winnerName, store, walk }) {
  const info = [];
  if (walk) info.push(`🚶 도보 약 ${walk.minutes}분 (약 ${formatMeters(walk.walkM)})`);
  if (store && store.address) info.push(`📍 ${store.address}`);
  if (store && store.memo) info.push(`📝 ${store.memo}`);

  const storeUrl = store ? linkUrl(store.url) : null;
  const body = [
    bannerBlock(),
    titleBlock(parts),
    {
      type: 'TextBlock',
      text: `🎯 ${winnerName || ''}`,
      horizontalAlignment: 'Center',
      size: 'ExtraLarge',
      weight: 'Bolder',
      color: 'Accent',
      wrap: true,
    },
  ];
  if (info.length) {
    body.push({
      type: 'TextBlock',
      text: info.join(' · '),
      horizontalAlignment: 'Center',
      isSubtle: true,
      wrap: true,
      spacing: 'Small',
    });
  }
  body.push(linksBlock([storeUrl ? `[네이버 지도에서 보기](${storeUrl})` : null, appLink()]));
  return wrapCard(body);
}

function buildInsufficientCard({ parts, note }) {
  return wrapCard([
    bannerBlock(),
    titleBlock(parts),
    { type: 'TextBlock', text: String(note || ''), horizontalAlignment: 'Center', wrap: true, spacing: 'Medium' },
    linksBlock([appLink()]),
  ]);
}

function wrapCard(body) {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
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
