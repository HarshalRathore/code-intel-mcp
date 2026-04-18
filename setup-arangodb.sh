#!/usr/bin/env bash
set -euo pipefail

ARANGO_HOST="http://localhost:8529"
ARANGO_USER="root"
ARANGO_PASS="code_intel_dev"
DB_NAME="code_intel"
MAX_RETRIES=30
RETRY_INTERVAL=2

echo "=== ArangoDB Setup Script ==="

wait_for_arango() {
  echo "Waiting for ArangoDB to be ready..."
  for i in $(seq 1 $MAX_RETRIES); do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "$ARANGO_USER:$ARANGO_PASS" "$ARANGO_HOST/_api/version")
    if [ "$HTTP_CODE" = "200" ]; then
      echo "ArangoDB is ready!"
      return 0
    fi
    echo "  Attempt $i/$MAX_RETRIES — not ready yet, waiting ${RETRY_INTERVAL}s..."
    sleep $RETRY_INTERVAL
  done
  echo "ERROR: ArangoDB failed to start within $((MAX_RETRIES * RETRY_INTERVAL)) seconds"
  exit 1
}

create_database() {
  echo "Creating database '$DB_NAME'..."
  RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
    -u "$ARANGO_USER:$ARANGO_PASS" \
    -X POST \
    "$ARANGO_HOST/_api/database" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$DB_NAME\"}")

  if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "201" ]; then
    echo "  Database '$DB_NAME' created."
  elif [ "$RESPONSE" = "409" ]; then
    echo "  Database '$DB_NAME' already exists (409 Conflict — continuing)."
  else
    echo "  WARNING: Database creation returned HTTP $RESPONSE"
  fi
}

create_collection() {
  local db="$1"
  local name="$2"
  local type="$3"

  echo "Creating collection '$name' (type=$type) in database '$db'..."
  RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
    -u "$ARANGO_USER:$ARANGO_PASS" \
    -X POST \
    "$ARANGO_HOST/_db/$db/_api/collection" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$name\", \"type\": $type}")

  if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "201" ]; then
    echo "  Collection '$name' created."
  elif [ "$RESPONSE" = "409" ]; then
    echo "  Collection '$name' already exists (409 — continuing)."
  else
    echo "  WARNING: Collection creation returned HTTP $RESPONSE"
  fi
}

create_index() {
  local db="$1"
  local collection="$2"
  local fields="$3"
  local unique="$4"
  local index_type="${5:-hash}"

  echo "Creating index on '$collection'.$fields (type=$index_type, unique=$unique)..."
  RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
    -u "$ARANGO_USER:$ARANGO_PASS" \
    -X POST \
    "$ARANGO_HOST/_db/$db/_api/index?collection=$collection" \
    -H "Content-Type: application/json" \
    -d "{\"type\": \"$index_type\", \"fields\": $fields, \"unique\": $unique}")

  if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "201" ]; then
    echo "  Index created."
  elif [ "$RESPONSE" = "409" ]; then
    echo "  Index already exists (409 — continuing)."
  else
    echo "  WARNING: Index creation returned HTTP $RESPONSE"
  fi
}

verify_setup() {
  echo ""
  echo "=== Verification ==="

  echo "1. Checking database '$DB_NAME' exists..."
  DBS=$(curl -s -u "$ARANGO_USER:$ARANGO_PASS" "$ARANGO_HOST/_api/database")
  echo "$DBS" | python3 -c "import sys,json; dbs=json.load(sys.stdin)['result']; print(f'  Databases: {dbs}'); assert '$DB_NAME' in dbs, f'Database $DB_NAME not found!'; print(f'  ✅ Database $DB_NAME exists')" 2>/dev/null || echo "  ⚠️  Could not verify database"

  echo "2. Checking collections..."
  COLLS=$(curl -s -u "$ARANGO_USER:$ARANGO_PASS" "$ARANGO_HOST/_db/$DB_NAME/_api/collection")
  echo "$COLLS" | python3 -c "import sys,json; colls=[c['name'] for c in json.load(sys.stdin)['result']]; print(f'  Collections: {colls}'); assert 'cpg_nodes' in colls, 'cpg_nodes missing!'; assert 'cpg_edges' in colls, 'cpg_edges missing!'; print('  ✅ Both collections exist')" 2>/dev/null || echo "  ⚠️  Could not verify collections"

  echo "3. Checking edge collection type..."
  EDGE_PROPS=$(curl -s -u "$ARANGO_USER:$ARANGO_PASS" "$ARANGO_HOST/_db/$DB_NAME/_api/collection/cpg_edges/properties")
  echo "$EDGE_PROPS" | python3 -c "import sys,json; props=json.load(sys.stdin); t=props.get('type',-1); print(f'  cpg_edges type={t} (expected 3=edge)'); assert t==3, f'Wrong type: {t}'; print('  ✅ cpg_edges is edge collection')" 2>/dev/null || echo "  ⚠️  Could not verify edge collection type"

  echo "4. Checking indexes on cpg_nodes..."
  IDX=$(curl -s -u "$ARANGO_USER:$ARANGO_PASS" "$ARANGO_HOST/_db/$DB_NAME/_api/index?collection=cpg_nodes")
  echo "$IDX" | python3 -c "import sys,json; idxs=[i['fields'] for i in json.load(sys.stdin)['indexes'] if i['type']!='primary']; print(f'  cpg_nodes indexes: {idxs}'); print(f'  ✅ {len(idxs)} non-primary indexes')" 2>/dev/null || echo "  ⚠️  Could not verify indexes"

  echo "5. Checking indexes on cpg_edges..."
  IDX=$(curl -s -u "$ARANGO_USER:$ARANGO_PASS" "$ARANGO_HOST/_db/$DB_NAME/_api/index?collection=cpg_edges")
  echo "$IDX" | python3 -c "import sys,json; idxs=[i['fields'] for i in json.load(sys.stdin)['indexes'] if i['type']!='primary']; print(f'  cpg_edges indexes: {idxs}'); print(f'  ✅ {len(idxs)} non-primary indexes')" 2>/dev/null || echo "  ⚠️  Could not verify indexes"

  echo ""
  echo "=== Setup Complete ==="
}

wait_for_arango
create_database

create_collection "$DB_NAME" "cpg_nodes" 2
create_collection "$DB_NAME" "cpg_edges" 3

create_index "$DB_NAME" "cpg_nodes" "[\"name\"]" false hash
create_index "$DB_NAME" "cpg_nodes" "[\"label\"]" false hash
create_index "$DB_NAME" "cpg_nodes" "[\"filename\"]" false hash
create_index "$DB_NAME" "cpg_nodes" "[\"TYPE_FULL_NAME\"]" false hash

create_index "$DB_NAME" "cpg_edges" "[\"label\"]" false hash
create_index "$DB_NAME" "cpg_edges" "[\"_from\"]" false hash
create_index "$DB_NAME" "cpg_edges" "[\"_to\"]" false hash

verify_setup