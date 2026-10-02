// Activity matcher: scores how similar two free-text "what are you doing" prompts are.
//
// Score (0..1) blends three signals:
//   1. Category overlap — words are mapped to broad activity categories
//      ("lifting", "gym", "workout" -> fitness) so different phrasings still match.
//   2. Keyword overlap — cosine similarity over stemmed, stopword-free tokens.
//   3. Fuzzy overlap — character trigram similarity, which tolerates typos
//      ("progamming" vs "programming").

const STOPWORDS = new Set(
  `a an the and or but if so to of in on at for with from by about into over after before
  i im i'm me my mine we us our you your he she it they them their this that these those
  am is are was were be been being do does did doing done have has had having
  just now right currently rn atm some any all very really kinda sort of like want wanna gonna
  going go get getting got trying try tryna little bit lot new up out off here there
  someone somebody anyone anybody people person together with who what how when where why
  can could would should will shall may might must need looking look for`
    .split(/\s+/)
    .filter(Boolean)
);

// Category -> trigger stems. Words are matched after stemming, and prefixes of 4+ chars count.
const CATEGORIES = {
  coding: ['code', 'coding', 'program', 'develop', 'dev', 'debug', 'hack', 'hackathon', 'javascript', 'python', 'java', 'react', 'software', 'app', 'website', 'leetcode', 'algorithm', 'typescript', 'rust', 'golang', 'api', 'frontend', 'backend', 'engineer'],
  studying: ['study', 'studi', 'homework', 'exam', 'test', 'learn', 'revis', 'lectur', 'class', 'course', 'assignment', 'essay', 'thesis', 'research', 'math', 'calculus', 'physic', 'chemistr', 'biolog', 'history', 'school', 'university', 'college', 'quiz', 'flashcard', 'pomodoro'],
  reading: ['read', 'book', 'novel', 'kindle', 'librar', 'poem', 'poetry', 'manga', 'comic', 'article'],
  writing: ['write', 'writ', 'blog', 'journal', 'story', 'screenplay', 'author', 'draft', 'poem'],
  fitness: ['gym', 'workout', 'exercis', 'lift', 'weight', 'run', 'jog', 'cardio', 'yoga', 'pilat', 'crossfit', 'train', 'fit', 'hiit', 'stretch', 'pushup', 'squat', 'swim', 'cycl', 'bike', 'marathon', 'hike', 'walk'],
  gaming: ['game', 'gaming', 'play', 'xbox', 'playstation', 'ps5', 'nintendo', 'switch', 'steam', 'minecraft', 'fortnite', 'valorant', 'league', 'lol', 'chess', 'dota', 'csgo', 'overwatch', 'rpg', 'mmo', 'fps', 'roblox', 'apex', 'zelda', 'pokemon'],
  music: ['music', 'song', 'guitar', 'piano', 'drum', 'sing', 'band', 'produc', 'beat', 'dj', 'violin', 'bass', 'ukulele', 'rap', 'compos', 'listen', 'spotify', 'album', 'concert', 'jam'],
  art: ['draw', 'paint', 'sketch', 'art', 'design', 'illustrat', 'photoshop', 'figma', 'animat', 'sculpt', 'craft', 'knit', 'crochet', 'sew', 'pottery', 'photo', 'doodl', 'watercolor', 'procreat'],
  cooking: ['cook', 'bake', 'recip', 'kitchen', 'dinner', 'lunch', 'breakfast', 'meal', 'food', 'eat', 'pasta', 'pizza', 'cake', 'bread', 'grill', 'bbq', 'chef', 'snack', 'brunch'],
  watching: ['watch', 'movi', 'film', 'netflix', 'show', 'seri', 'anime', 'youtube', 'tv', 'episod', 'documentar', 'stream', 'hbo', 'disney', 'cinema'],
  working: ['work', 'job', 'office', 'meeting', 'email', 'spreadsheet', 'excel', 'report', 'project', 'deadline', 'startup', 'business', 'freelanc', 'client', 'present', 'slide', 'pitch'],
  language: ['language', 'spanish', 'french', 'german', 'japanese', 'chines', 'korean', 'italian', 'duolingo', 'english', 'arabic', 'turkish', 'portugues', 'vocab', 'grammar', 'fluent'],
  chilling: ['chill', 'relax', 'bored', 'nothing', 'hang', 'lazy', 'rest', 'couch', 'vibe', 'talk', 'chat', 'lonely'],
  meditation: ['meditat', 'mindful', 'breath', 'journal', 'therap', 'selfcare'],
  cleaning: ['clean', 'laundr', 'tidy', 'organiz', 'declutter', 'dish', 'vacuum', 'chore'],
  outdoors: ['park', 'beach', 'hike', 'camp', 'garden', 'fish', 'climb', 'outdoor', 'nature', 'surf', 'ski', 'snowboard'],
  travel: ['travel', 'trip', 'flight', 'airport', 'vacation', 'explor', 'visit', 'tour', 'commut', 'train', 'bus'],
};

// Very small suffix-stripping stemmer; good enough to align "running"/"runs"/"run".
function stem(word) {
  let w = word;
  if (w.length > 5 && w.endsWith('ies')) w = w.slice(0, -3) + 'i';
  else if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  // "running" -> "runn" -> "run"
  if (w.length > 3 && w[w.length - 1] === w[w.length - 2] && !'lsz'.includes(w[w.length - 1])) {
    w = w.slice(0, -1);
  }
  return w;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/'/g, ''))
    .filter((t) => t && !STOPWORDS.has(t));
}

// Longer words that are nearly the same spelling count as a trigger hit ("progamming").
function nearlySame(w, trig) {
  return w.length >= 6 && trig.length >= 6 && jaccard(trigrams([w]), trigrams([trig])) >= 0.45;
}

function categoriesFor(stems, rawTokens) {
  const found = new Set();
  const words = new Set([...stems, ...rawTokens]);
  for (const [cat, triggers] of Object.entries(CATEGORIES)) {
    for (const trig of triggers) {
      for (const w of words) {
        if (w === trig || (trig.length >= 4 && w.startsWith(trig)) || (w.length >= 4 && trig.startsWith(w)) || nearlySame(w, trig)) {
          found.add(cat);
          break;
        }
      }
      if (found.has(cat)) break;
    }
  }
  return found;
}

function trigrams(stems) {
  const grams = new Set();
  for (const s of stems) {
    const padded = `  ${s} `;
    for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function cosine(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.sqrt(a.size * b.size);
}

// Precompute everything needed for scoring, so each prompt is analysed once.
function analyze(text) {
  const raw = tokenize(text);
  const stems = raw.map(stem);
  return {
    stems: new Set(stems),
    categories: categoriesFor(stems, raw),
    grams: trigrams(stems),
  };
}

function score(a, b) {
  const cat = jaccard(a.categories, b.categories);
  const kw = cosine(a.stems, b.stems);
  const fuzzy = jaccard(a.grams, b.grams);
  let s = 0.45 * cat + 0.35 * kw + 0.2 * fuzzy;
  // Exact same wording should always be a top match.
  if (kw === 1 && a.stems.size) s = Math.max(s, 0.95);
  // Sharing a category with only light wording overlap is still a meaningful match.
  if (cat > 0) s = Math.max(s, 0.3 + 0.4 * cat);
  return Math.min(1, s);
}

module.exports = { analyze, score, tokenize, stem };
