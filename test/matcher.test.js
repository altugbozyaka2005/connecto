const test = require('node:test');
const assert = require('node:assert');
const { analyze, score } = require('../matcher');

const s = (a, b) => score(analyze(a), analyze(b));

test('identical prompts score near 1', () => {
  assert.ok(s('studying calculus', 'Studying calculus!') >= 0.95);
});

test('different phrasings of the same activity match well', () => {
  assert.ok(s('lifting weights at the gym', 'doing a workout') >= 0.5);
  assert.ok(s('programming in python', 'coding a react app') >= 0.5);
  assert.ok(s('running', 'going for a run') >= 0.5);
});

test('tolerates typos', () => {
  assert.ok(s('progamming', 'programming') > 0.4);
});

test('unrelated activities rank below related ones', () => {
  const base = 'studying for my biology exam';
  assert.ok(s(base, 'revising chemistry homework') > s(base, 'playing valorant'));
  assert.ok(s(base, 'playing valorant') < 0.15);
});

test('empty prompts do not match', () => {
  assert.strictEqual(s('', 'coding'), 0);
});
