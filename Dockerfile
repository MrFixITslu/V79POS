ARG NODE_BASE=node:22-alpine
FROM ${NODE_BASE} AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm db:generate && pnpm build

FROM ${NODE_BASE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY scripts/docker-entrypoint.sh /app/scripts/docker-entrypoint.sh
RUN chmod 755 /app/scripts/docker-entrypoint.sh \
 && find /app/apps/api/public -type d -exec chmod 755 {} + \
 && find /app/apps/api/public -type f -exec chmod 644 {} +
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
USER node
CMD ["node", "apps/api/dist/server.js"]
