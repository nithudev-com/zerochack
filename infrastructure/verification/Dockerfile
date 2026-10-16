# Resolve and review the resulting image digest before activation. No runtime pulls.
FROM node:24-bookworm-slim
WORKDIR /opt/runner
RUN npm install --ignore-scripts --no-audit --no-fund typescript@5.9.3 && npm cache clean --force
COPY worker.mjs ./worker.mjs
# An operator may derive an image that adds a reviewed trusted-wordpress.json.
# Never copy a customer-supplied reference into that location.
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["node", "/opt/runner/worker.mjs"]
