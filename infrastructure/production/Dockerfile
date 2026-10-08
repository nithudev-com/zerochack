FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace

FROM base AS build
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci && npm run db:generate
ARG NEXT_PUBLIC_API_URL=https://codebandage.com/v1
ARG APP_URL=https://codebandage.com
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL APP_URL=$APP_URL
RUN npm run build -w @zerochack/api && npm run build -w @zerochack/worker && npm run build -w @zerochack/web

FROM build AS tools
ENV NODE_ENV=production
USER node
CMD ["npm", "run", "db:migrate:deploy"]

FROM build AS dependencies
RUN npm prune --omit=dev

FROM base AS app
ENV NODE_ENV=production NODE_EXTRA_CA_CERTS=/run/trust/ca.crt
COPY --from=dependencies --chown=node:node /workspace/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /workspace/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /workspace/apps/worker/dist ./apps/worker/dist
USER node

FROM app AS api
CMD ["node", "apps/api/dist/server.js"]

FROM app AS worker
CMD ["node", "apps/worker/dist/index.js"]

FROM base AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /workspace/apps/web/public ./apps/web/public
USER node
CMD ["node", "apps/web/server.js"]
