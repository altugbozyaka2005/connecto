# Node 24 LTS: includes the built-in SQLite module (node:sqlite) used by db.js.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The matching model (~280 MB) is baked into the image, so the server never downloads it at runtime.
COPY embeddings.js ./
COPY scripts/fetch-model.js scripts/
RUN node scripts/fetch-model.js

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
