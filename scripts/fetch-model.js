// Downloads the matching model into ./models (run at image build time so the server starts offline).
require('../embeddings').load().then((ok) => process.exit(ok ? 0 : 1));
