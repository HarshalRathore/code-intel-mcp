FROM node:20-slim AS builder

WORKDIR /build

COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM eclipse-temurin:21-jdk AS joern

ARG JOERN_VERSION=4.0.523

RUN apt-get update && apt-get install -y curl unzip && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/joernio/joern/releases/download/v${JOERN_VERSION}/joern-install.sh \
    -o /tmp/joern-install.sh && \
    chmod +x /tmp/joern-install.sh && \
    /tmp/joern-install.sh --install-dir /opt/joern --version v${JOERN_VERSION} && \
    rm -f /tmp/joern-install.sh

FROM node:20-slim

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY --from=joern /opt/joern /opt/joern

COPY --from=builder /build/dist /app/dist
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/package.json /app/

COPY setup-arangodb.sh /app/setup-arangodb.sh
RUN chmod +x /app/setup-arangodb.sh

ENV JOERN_CLI_PATH=/opt/joern/joern-cli
ENV ARANGO_HOST=http://arangodb:8529
ENV ARANGO_USER=root
ENV ARANGO_PASS=code_intel_dev
ENV ARANGO_DB=code_intel
ENV NODE_ENV=production

WORKDIR /app

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]