const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const storageSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'storage.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('assignment pin state is persisted with the people bundle', () => {
  assert.match(appSource, /assignmentPins:\s*\{\}/);
  assert.match(appSource, /const\s+ASSIGNMENT_PINS_KEY\s*=\s*'ls\.assignmentPins\.v1'/);
  assert.match(appSource, /function\s+normalizeAssignmentPins\(input\)/);
  assert.match(appSource, /assignmentPins:\s*state\.assignmentPins/);
  assert.match(storageSource, /const\s+KEY_ASSIGNMENT_PINS\s*=\s*'ls\.assignmentPins\.v1'/);
  assert.match(storageSource, /assignmentPins:\s*safeParse\(localStorage\.getItem\(KEY_ASSIGNMENT_PINS\),\s*\{\}\)/);
  assert.match(storageSource, /localStorage\.setItem\(KEY_ASSIGNMENT_PINS,\s*JSON\.stringify\(safe\.assignmentPins\s*\|\|\s*\{\}\)\)/);
  assert.match(htmlSource, /js\/app\.js\?v=23/);
});

test('assignment pins reapply next day at 10:50 except Friday waits until Monday', () => {
  assert.match(appSource, /function\s+getAssignmentPinTimeState\(date\s*=\s*new Date\(\)\)/);
  assert.match(appSource, /weekday:\s*'short'/);
  assert.match(appSource, /const\s+monToThu\s*=\s*\['Mon',\s*'Tue',\s*'Wed',\s*'Thu'\]/);
  assert.match(appSource, /const\s+dailyRestoreWindow\s*=\s*monToThu\.includes\(seoul\.weekday\)/);
  assert.match(appSource, /minutesFromMidnight\s*>=\s*\(10\s*\*\s*60\s*\+\s*50\)/);
  assert.match(appSource, /minutesFromMidnight\s*<\s*\(13\s*\*\s*60\s*\+\s*30\)/);
  assert.match(appSource, /active:\s*dailyRestoreWindow/);
  assert.match(appSource, /seoul\.weekday\s*===\s*'Fri'/);
  assert.match(appSource, /temporarilyReleased/);
  assert.doesNotMatch(appSource, /mondayRestoreWindow/);
});

test('assignment reset keeps only currently effective pinned people', () => {
  assert.match(appSource, /function\s+buildAssignmentsFromEffectivePins\(\)/);
  assert.match(appSource, /state\.assignments\s*=\s*buildAssignmentsFromEffectivePins\(\)/);
  assert.match(appSource, /function\s+applyEffectiveAssignmentPins\(\)/);
  assert.match(appSource, /isAssignmentPinEffectiveNow\(\)/);
  assert.match(appSource, /if\s*\(state\.assignmentPins\[name\]\s*&&\s*state\.assignmentPins\[name\]\.pinned\)/);
});

test('person tags include a pin icon and pin management menu', () => {
  assert.match(appSource, /className\s*=\s*'person-pin-btn'/);
  assert.match(appSource, /person-pin-body/);
  assert.match(appSource, /person-pin-needle-outline/);
  assert.match(appSource, /person-pin-needle/);
  assert.match(appSource, /data-action="pin"/);
  assert.match(appSource, /data-action="unpin"/);
  assert.match(appSource, /function\s+showAssignmentPinMenu\(name,\s*currentGroup\)/);
  assert.match(appSource, /assignment-pin-modal/);
  assert.match(stylesSource, /\.person-pin-btn/);
  assert.match(stylesSource, /\.person-pin-body\s*{[\s\S]*fill:\s*#ef7fa8;/);
  assert.match(stylesSource, /\.person-pin-needle-outline\s*{[\s\S]*stroke:\s*#a94870;[\s\S]*stroke-width:\s*3;/);
  assert.match(stylesSource, /\.person-pin-needle\s*{[\s\S]*stroke:\s*#fff;[\s\S]*stroke-width:\s*1\.35;/);
  assert.match(stylesSource, /\.person-tag\.is-pinned \.person-pin-body\s*{[\s\S]*fill:\s*#128fdf;/);
  assert.match(stylesSource, /\.person-tag\.is-pinned \.person-pin-needle-outline\s*{[\s\S]*stroke:\s*#096aa8;/);
  assert.match(stylesSource, /\.person-tag\.is-pinned/);
});

test('desktop assignment columns give person names more room by reducing map width', () => {
  assert.match(stylesSource, /#panel-meal\s*{[\s\S]*grid-template-columns:\s*minmax\(500px,\s*560px\)\s+minmax\(0,\s*0\.85fr\)\s+minmax\(0,\s*0\.65fr\);/);
  assert.match(stylesSource, /\.person-tag\s*{[\s\S]*width:\s*min\(168px,\s*calc\(100%\s*-\s*4px\)\);/);
  assert.match(stylesSource, /\.person-tag-label\s*{[\s\S]*text-align:\s*center;/);
});

test('assignment pin guidance uses scan-friendly rows instead of one wrapped sentence', () => {
  assert.match(appSource, /assignment-pin-help/);
  assert.match(appSource, /<strong>적용<\/strong>/);
  assert.match(appSource, /<strong>해제<\/strong>/);
  assert.match(appSource, /<strong>재적용<\/strong>/);
  assert.match(appSource, /다음날 10:50부터/);
  assert.match(appSource, /금요일은 차주 월요일 10:50/);
  assert.doesNotMatch(appSource, /금요일은 일시 해제/);
  assert.match(stylesSource, /\.assignment-pin-help/);
  assert.match(stylesSource, /\.assignment-pin-help\s+strong/);
});
