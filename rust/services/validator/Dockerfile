FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY services/validator ./services/validator
RUN npm install && npm run build -w @noetis/protocol -w @noetis/crypto -w @noetis/currency -w @noetis/blockchain -w @noetis/database -w @noetis/validator

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/services/validator ./services/validator
ENV NODE_ENV=production
EXPOSE 3003
CMD ["node", "services/validator/dist/index.js"]
