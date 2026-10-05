// Matching by meaning: a small multilingual model turns each activity into a vector, so
// "jugando al ajedrez" lands next to "playing chess" and "lifting weights" next to "working out".
// It runs on this server (no API key, nothing typed leaves the machine). If the model can't load,
// matching falls back to the word-based scorer in matcher.js.
const path = require('path');

const MODEL = 'Xenova/paraphrase-multilingual-mpnet-base-v2';
const MODEL_DIR = process.env.MODEL_DIR || path.join(__dirname, 'models');
const enabled = process.env.EMBEDDINGS !== 'off';
const CACHE_MAX = 5000; // most people type the same few hundred activities

let loading = null;
const cache = new Map(); // lowercased text -> Float32Array (unit length)
const pending = new Map(); // lowercased text -> Promise, so a burst of the same text embeds once

function load() {
  if (!enabled) return Promise.resolve(null);
  if (!loading) {
    loading = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = MODEL_DIR;
      const t0 = Date.now();
      const extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
      if (process.env.NODE_ENV !== 'test') console.log(`Embeddings ready (${MODEL}, ${Date.now() - t0} ms)`);
      return extractor;
    })().catch((err) => {
      console.error('Embeddings unavailable, using word matching only:', err.message);
      return null;
    });
  }
  return loading;
}

async function embed(text) {
  const key = String(text || '').trim().toLowerCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  if (!pending.has(key)) {
    pending.set(key, (async () => {
      const extractor = await load();
      if (!extractor) return null;
      const out = await extractor(key, { pooling: 'mean', normalize: true });
      const vec = Float32Array.from(out.data);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, vec);
      return vec;
    })().catch(() => null).finally(() => pending.delete(key)));
  }
  return pending.get(key);
}

// Adds the vector to a matcher profile once it's ready. Resolves to true if it did.
async function attach(profile, text) {
  const vec = await embed(text);
  if (vec) profile.vec = vec;
  return !!vec;
}

module.exports = { load, embed, attach, MODEL, enabled };
