// Matching by meaning (embeddings.js). Downloads the model into ./models on the first run.
const test = require('node:test');
const assert = require('node:assert');
const { analyze, score, lexical } = require('../matcher');
const embeddings = require('../embeddings');

async function scored(a, b) {
  const [pa, pb] = [analyze(a), analyze(b)];
  await Promise.all([embeddings.attach(pa, a), embeddings.attach(pb, b)]);
  return score(pa, pb);
}

const MIN_SCORE = 0.15; // server.js: lowest score shown as a match

test('the model loads', { timeout: 600000 }, async () => {
  assert.ok(await embeddings.load(), 'model should load');
});

test('same meaning, different words or languages, now match', async () => {
  for (const [a, b] of [
    ['grinding LeetCode', 'prepping for coding interviews'],
    ['playing chess', 'satranç oynuyorum'],
    ['playing chess', 'jugando al ajedrez'],
    ['working out at the gym', 'lifting weights'],
    ['going for a run', 'jogging in the park'],
    ['learning Spanish', 'practicing español conversation'],
  ]) {
    const s = await scored(a, b);
    assert.ok(s >= MIN_SCORE, `"${a}" ~ "${b}" scored ${s.toFixed(2)}`);
  }
  // Translations are near-identical.
  assert.ok(await scored('playing chess', 'jugando al ajedrez') > 0.9);
});

test('unrelated activities still do not match', async () => {
  for (const [a, b] of [
    ['playing chess', 'cooking dinner'],
    ['grinding LeetCode', 'cooking dinner'],
    ['learning Spanish', 'lifting weights'],
    ['reading a novel', 'practicing guitar'],
  ]) {
    const s = await scored(a, b);
    assert.ok(s < MIN_SCORE, `"${a}" vs "${b}" scored ${s.toFixed(2)}`);
  }
});

test('word matching still decides when it scores higher (typos, exact phrases)', async () => {
  const [a, b] = ['studying calculus', 'studyng calculus'];
  const lex = lexical(analyze(a), analyze(b));
  assert.ok(await scored(a, b) >= lex);
});
