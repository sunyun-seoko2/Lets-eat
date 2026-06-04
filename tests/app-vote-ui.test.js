const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('vote voter dropdown displays person name with role while keeping name value', () => {
  assert.match(appSource, /function\s+formatPersonLabel\(name\)/);
  assert.match(appSource, /op\.value\s*=\s*name/);
  assert.match(appSource, /op\.textContent\s*=\s*formatPersonLabel\(name\)/);
});

test('vote setup explains voter dropdown appears after vote creation', () => {
  assert.match(htmlSource, /투표 대상자 선택 목록은 투표 생성 후 표시됩니다/);
  assert.doesNotMatch(htmlSource, /생성 전에는 이름이 표시되지 않습니다/);
});
