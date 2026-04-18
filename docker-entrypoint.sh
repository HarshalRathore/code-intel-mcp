#!/bin/bash
set -e

echo "[code-intel-mcp] Waiting for ArangoDB at ${ARANGO_HOST}..."

MAX_RETRIES=30
for i in $(seq 1 $MAX_RETRIES); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "${ARANGO_USER}:${ARANGO_PASS}" "${ARANGO_HOST}/_api/version" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "[code-intel-mcp] ArangoDB is ready!"
    break
  fi
  echo "  Attempt $i/$MAX_RETRIES — waiting 2s..."
  sleep 2
done

if [ "$HTTP_CODE" != "200" ]; then
  echo "[code-intel-mcp] WARNING: ArangoDB not reachable. Queries will fail until ArangoDB is available."
fi

bash /app/setup-arangodb.sh 2>/dev/null || true

echo "[code-intel-mcp] Starting MCP server..."
exec "$@"