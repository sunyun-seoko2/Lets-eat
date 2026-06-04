/**
 * App 설정.
 *
 * storage: 'azure' | 'local'
 *   - 'azure'  → Azure Table Storage 사용 (실시간 공유)
 *   - 'local'  → 브라우저 localStorage (단독 사용)
 *
 * azure: storage === 'azure' 일 때만 사용
 *   - account: Storage Account 이름
 *   - sas:     SAS Token 문자열 (선행 '?' 없이)
 *   - tableStores / tableVotes / tablePeople / tableRandomHistory: 사용할 테이블 이름
 *     (기본 stores/votes/people/randomhistory)
 *
 * corsProxy: 네이버 place 페이지 HTML 을 가져오는 데 사용하는 CORS 프록시.
 * placeLookup: URL 자동 등록 시 좌표/주소 자동 추출 활성화 여부.
 * pollIntervalMs: Azure 모드일 때 데이터 폴링 간격 (ms).
 * pollIntervalRouletteMs: 룰렛 회전 중 폴링 간격 (ms).
 * rouletteSpinLeadMs: 다른 브라우저가 회전 세션을 받을 수 있도록 실제 시작 전 대기 시간 (ms).
 * rouletteSpinDurationMs: 회전 애니메이션 시간 (ms).
 */
window.AppConfig = {
  storage: 'azure',
  azure: {
    account: 'agenthta1de',
    sas: 'sv=2025-11-05&ss=bfqt&srt=sco&sp=rwdlacupiytfx&se=2028-05-01T13:42:29Z&st=2026-05-13T05:27:29Z&spr=https&sig=%2FbGPHhAkPfZl406cd1ntjVoAY8GHxzwCQD%2F8uL9kPhM%3D',
    tableStores: 'stores',
    tableVotes: 'votes',
    tablePeople: 'people',
    tableRandomHistory: 'randomhistory',
  },

  corsProxy: 'https://corsproxy.io/?url=',
  placeLookup: true,

  pollIntervalMs: 3000,        // 일반 폴링 주기
  pollIntervalVoteMs: 3000,    // 투표 진행 중 폴링 주기
  pollIntervalRouletteMs: 1000, // 룰렛 회전 중 폴링 주기
  rouletteSpinLeadMs: 2000,    // 다른 사용자 브라우저가 회전 시작 전에 세션을 받을 시간
  rouletteSpinDurationMs: 8000,
};
