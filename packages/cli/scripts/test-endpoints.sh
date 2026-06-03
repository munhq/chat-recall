#!/bin/bash
# Quick endpoint testing script

set -e

BASE_URL="http://localhost:5000"

echo "Testing Chat-Recall API Endpoints"
echo "=================================="
echo ""

# Test 1: Health
echo "1. Testing health endpoint..."
HEALTH=$(curl -s "${BASE_URL}/health")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo "✅ Health check passed"
else
    echo "❌ Health check failed: $HEALTH"
    exit 1
fi
echo ""

# Test 2: Status
echo "2. Testing status endpoint..."
STATUS=$(curl -s "${BASE_URL}/api/status")
if echo "$STATUS" | grep -q '"totalSessions"'; then
    SESSIONS=$(echo "$STATUS" | grep -o '"totalSessions":[0-9]*' | cut -d':' -f2)
    CHUNKS=$(echo "$STATUS" | grep -o '"totalChunks":[0-9]*' | cut -d':' -f2)
    echo "✅ Status check passed"
    echo "   Sessions: $SESSIONS"
    echo "   Chunks: $CHUNKS"
else
    echo "❌ Status check failed: $STATUS"
    exit 1
fi
echo ""

# Test 3: Search
echo "3. Testing search endpoint..."
SEARCH=$(curl -s -X POST "${BASE_URL}/api/search" \
    -H 'Content-Type: application/json' \
    -d '{"query":"test","topK":3}')
if echo "$SEARCH" | grep -q '"results"'; then
    COUNT=$(echo "$SEARCH" | grep -o '"count":[0-9]*' | cut -d':' -f2)
    echo "✅ Search passed"
    echo "   Results: $COUNT"
else
    echo "❌ Search failed: $SEARCH"
    exit 1
fi
echo ""

# Test 4: Recent sessions
echo "4. Testing recent conversations endpoint..."
RECENT=$(curl -s "${BASE_URL}/api/conversations/recent?limit=5")
if echo "$RECENT" | grep -q '"sessions"'; then
    COUNT=$(echo "$RECENT" | grep -o '"count":[0-9]*' | cut -d':' -f2)
    echo "✅ Recent sessions passed"
    echo "   Sessions: $COUNT"
else
    echo "❌ Recent sessions failed: $RECENT"
    exit 1
fi
echo ""

echo "=================================="
echo "All tests passed! ✅"
echo ""
echo "Next steps:"
echo "  1. Open http://localhost:5173 in browser"
echo "  2. Try searching for conversations"
echo "  3. Click on a result to view the conversation"
