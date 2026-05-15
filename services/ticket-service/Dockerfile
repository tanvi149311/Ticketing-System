FROM node:20-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine AS production
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nodejs -u 1001
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs src/ ./src/
COPY --chown=nodejs:nodejs package*.json ./
USER nodejs
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3003/health || exit 1
CMD ["node", "src/index.js"]