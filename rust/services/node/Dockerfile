FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY services/node ./services/node
RUN npm install && npm run build -w @noetis/protocol -w @noetis/crypto -w @noetis/currency -w @noetis/ollama-client -w @noetis/node

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/services/node ./services/node
RUN ln -s /app/services/node/dist/cli.js /usr/local/bin/noetis-node
ENV NODE_ENV=production
ENTRYPOINT ["node", "services/node/dist/cli.js", "start"]
