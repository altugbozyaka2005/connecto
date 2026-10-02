# Node 24 LTS: includes the built-in SQLite module (node:sqlite) used by db.js.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
