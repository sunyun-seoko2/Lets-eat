const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const mapsSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'maps.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const stylesSource = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

test('vote results stay secret and summarize voters by role only', () => {
  assert.match(appSource, /function\s+formatVoteRoleSummary\(voters\)/);
  assert.match(appSource, /vote-role-summary/);
  assert.doesNotMatch(appSource, /voters\.map\(escapeHtml\)\.join\(', '\)/);
});

test('vote setup hint does not say names are hidden before creation', () => {
  assert.match(htmlSource, /투표 대상자 선택 목록은 투표 생성 후 표시됩니다\./);
  assert.doesNotMatch(htmlSource, /생성 전에는 이름이 표시되지 않습니다/);
});

test('random history clear all uses custom admin modal title instead of browser prompt', () => {
  assert.match(appSource, /await\s+verifyHistoryAdminPassword\('랜덤 \/ 후보 기록 전체 기록 삭제'\)/);
  assert.match(appSource, /confirmAppDialog\(\s*'랜덤 \/ 후보 기록 전체 기록 삭제'/);
  assert.doesNotMatch(appSource, /prompt\('기록 삭제 비밀번호를 입력하세요\.'\)/);
  assert.doesNotMatch(appSource, /confirm\(`\$\{targetMeal === 'all'/);
});

test('vote delete admin confirmation has a dedicated cute modal variant', () => {
  assert.match(appSource, /vote-delete-confirm-modal/);
  assert.match(appSource, /투표를 정리할 수 있어요/);
  assert.match(appSource, /confirmAppDialog\(\s*'🧺 투표 종료\/삭제'/);
});

test('map location button reloads only the map module before moving to fixed location', () => {
  assert.match(appSource, /await\s+Maps\.reload\('map'\)/);
  assert.match(mapsSource, /async\s+reload\(containerId\)/);
  assert.match(mapsSource, /reloadNaverMapScript\(\)/);
});

test('map info windows include a close button that closes the popup', () => {
  assert.match(mapsSource, /map-info-close/);
  assert.match(mapsSource, /function\s+bindInfoWindowCloseButton\(info\)/);
  assert.match(mapsSource, /closeBtn\.addEventListener\('click'/);
  assert.match(mapsSource, /info\.close\(\)/);
});

test('roulette reset confirmation uses the app modal instead of the browser confirm', () => {
  assert.match(appSource, /confirmAppDialog\(\s*'🧺 룰렛 초기화'/);
  assert.match(appSource, /className:\s*'vote-delete-confirm-modal'/);
  assert.doesNotMatch(appSource, /confirm\('룰렛 후보와 결과를 초기화할까요\?'\)/);
});

test('vote creation starts disabled until candidates are prepared', () => {
  assert.match(htmlSource, /id="btn-create-vote"[^>]*disabled/);
  assert.match(appSource, /function\s+setVoteCreateEnabled\(enabled\)/);
  assert.match(appSource, /setVoteCreateEnabled\(true\)/);
  assert.match(appSource, /setVoteCreateEnabled\(false\)/);
});

test('vote candidate pick buttons have a stronger action style', () => {
  assert.match(htmlSource, /id="btn-pick-vote"[^>]*vote-candidate-action/);
  assert.match(htmlSource, /id="btn-pick-vote-selected"[^>]*vote-candidate-action/);
  assert.match(stylesSource, /\.vote-candidate-action/);
});

test('app uses custom dialogs instead of browser native message boxes', () => {
  assert.doesNotMatch(appSource, /\balert\s*\(/);
  assert.doesNotMatch(appSource, /\bconfirm\s*\(/);
  assert.doesNotMatch(appSource, /\bprompt\s*\(/);
  assert.match(appSource, /function\s+showAppAlert\(/);
  assert.match(appSource, /function\s+promptAppDialog\(/);
});
