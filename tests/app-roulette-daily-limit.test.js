const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

test('roulette spin stores the spin day and blocks another spin until reset', () => {
  assert.match(appSource, /spunAt:\s*Date\.now\(\)/);
  assert.match(appSource, /isRouletteResultLocked\(current\)/);
  assert.match(appSource, /오늘 룰렛은 이미 완료되었습니다/);
  assert.match(appSource, /spinBtn\.disabled\s*=\s*isRouletteResultLocked\(session\)/);
});

test('roulette result auto reset clears saved roulette after next Seoul 09:00', () => {
  assert.match(appSource, /function\s+getRouletteAutoResetAtMs\(session\)/);
  assert.match(appSource, /Date\.UTC\(year,\s*month\s*-\s*1,\s*day\s*\+\s*1,\s*0,\s*0,\s*0,\s*0\)/);
  assert.match(appSource, /async\s+function\s+maybeAutoResetRouletteForMeal\(meal\)/);
  assert.match(appSource, /await\s+saveRouletteForMeal\(meal,\s*null\)/);
  assert.match(appSource, /startRouletteAutoResetWatcher\(\)/);
});
