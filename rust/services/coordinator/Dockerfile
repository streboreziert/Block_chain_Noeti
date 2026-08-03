FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY services/coordinator ./services/coordinator
RUN npm install && npm run build -w @noetis/protocol -w @noetis/crypto -w @noetis/database -w @noetis/scheduler -w @noetis/coordinator

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/services/coordinator ./services/coordinator
ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "services/coordinator/dist/index.js"]
