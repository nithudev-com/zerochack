FROM node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates perl-base && rm -rf /var/lib/apt/lists/*
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

FROM base AS runtime
# Package management is only needed in build/migration tooling.
RUN rm -rf /usr/local/lib/node_modules/npm && rm -f /usr/local/bin/npm /usr/local/bin/npx

FROM runtime AS app
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

FROM runtime AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /workspace/apps/web/public ./apps/web/public
USER node
CMD ["node", "apps/web/server.js"]
