const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

test('spin sessions use shared timing fields for cross-browser playback', () => {
  assert.match(appSource, /const\s+ROULETTE_DEFAULT_LEAD_MS\s*=/);
  assert.match(appSource, /const\s+ROULETTE_DEFAULT_DURATION_MS\s*=/);
  assert.match(appSource, /startAt:\s*Date\.now\(\)\s*\+\s*getRouletteSpinLeadMs\(\)/);
  assert.match(appSource, /durationMs:\s*getRouletteSpinDurationMs\(\)/);
  assert.match(appSource, /spinTurns:\s*getRouletteSpinTurns\(\)/);
});

test('shared render settles ended sessions and displays the resolved winner', () => {
  assert.match(appSource, /Roulette\.settle\(session\)/);
  assert.match(appSource, /Roulette\.getDisplayWinner\(session\)/);
  assert.match(appSource, /showRouletteWinner\(winner\s*\|\|\s*Roulette\.resolveWinner\(session\)/);
});

test('polling can switch to a roulette-specific realtime interval', () => {
  assert.match(appSource, /pollIntervalRouletteMs/);
  assert.match(appSource, /schedulePoll\(\);\s*\n\s*}\s*\n\s*$/m);
});
