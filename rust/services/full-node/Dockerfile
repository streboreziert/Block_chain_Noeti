FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.base.json config ./ 
COPY packages ./packages
COPY services/full-node ./services/full-node
RUN npm install && npm run build -w @noetis/protocol -w @noetis/crypto -w @noetis/currency -w @noetis/blockchain -w @noetis/p2p -w @noetis/full-node

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/config ./config
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/services/full-node ./services/full-node
ENV NODE_ENV=production
EXPOSE 4000 4001
ENTRYPOINT ["node", "services/full-node/dist/cli.js", "start", "--validator"]
