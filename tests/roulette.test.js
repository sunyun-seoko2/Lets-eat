const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createContext() {
  const calls = [];
  const ctx2d = {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
    shadowColor: '',
    shadowBlur: 0,
    clearRect() {},
    beginPath() {},
    arc() {},
    closePath() {},
    moveTo() {},
    fill() {},
    stroke() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    measureText(text) {
      return { width: String(text).length * 10 };
    },
    fillText(text, x, y) {
      calls.push({ text, x, y });
    },
  };
  const context = {
    console,
    Math,
    Date,
    performance: { now: () => 0 },
    requestAnimationFrame: () => {},
    document: {
      getElementById() {
        return { width: 440, height: 440, getContext: () => ctx2d };
      },
    },
    window: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'roulette.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'js/roulette.js' });
  context.window.Roulette.init('roulette-canvas');
  return context;
}

function sampleItems() {
  return [
    { id: 'a', name: '삼성원' },
    { id: 'b', name: '무궁화반점 종로점' },
    { id: 'c', name: '제주본가 종로5가점' },
    { id: 'd', name: '승우네식당' },
    { id: 'e', name: '종각상회' },
  ];
}

test('resolves the displayed winner from winnerId before stale winnerName', () => {
  const { window } = createContext();
  window.Roulette.setItems(sampleItems());

  const session = { winnerId: 'c', winnerName: '무궁화반점 종로점' };

  assert.equal(window.Roulette.getDisplayWinner(session), '제주본가 종로5가점');
});

test('settles an ended roulette session with the winner segment at the pointer', () => {
  const { window } = createContext();
  window.Roulette.setItems(sampleItems());

  const session = { winnerId: 'c', winnerName: '무궁화반점 종로점' };
  const winner = window.Roulette.settle(session);

  assert.equal(winner.name, '제주본가 종로5가점');
  assert.equal(window.Roulette.getPointerWinner().id, 'c');
});

test('wraps labels on natural word boundaries before character splitting', () => {
  const { window } = createContext();
  const lines = window.Roulette.__test.wrapLabelLines(
    { measureText: (text) => ({ width: String(text).length * 10 }) },
    '제주본가 종로5가점',
    55,
    2
  );

  assert.deepEqual(Array.from(lines), ['제주본가', '종로5가점']);
});

test('keeps labels without spaces on one ellipsized line instead of arbitrary character breaks', () => {
  const { window } = createContext();
  const lines = window.Roulette.__test.wrapLabelLines(
    { measureText: (text) => ({ width: String(text).length * 10 }) },
    '무궁화반점종로점',
    55,
    2
  );

  assert.equal(lines.length, 1);
  assert.match(lines[0], /…$/);
});
