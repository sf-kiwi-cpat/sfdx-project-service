#!/bin/bash
# Test script for async deployment endpoints
# Usage: ./test-deployment.sh [base_url] [project_id]

BASE_URL="${1:-http://localhost:3000}"
PROJECT_ID="${2:-123e4567-e89b-12d3-a456-426614174000}"

# Test credentials (these would come from a real Salesforce org in production)
CREDENTIALS='{
  "accessToken": "test-token-12345",
  "instanceUrl": "https://test.salesforce.com"
}'

echo "=== Async Deployment API Test Suite ==="
echo "Base URL: $BASE_URL"
echo "Project ID: $PROJECT_ID"
echo ""

# Test 1: POST /v1/projects/{id}/deployments (initiate deployment)
echo "Test 1: POST /v1/projects/{id}/deployments"
echo "Expected: 202 Accepted with deploymentId"
echo ""
DEPLOY_RESPONSE=$(curl -s -X POST \
  "$BASE_URL/v1/projects/$PROJECT_ID/deployments" \
  -H "Content-Type: application/json" \
  -d "$CREDENTIALS")

echo "Response:"
echo "$DEPLOY_RESPONSE" | jq . 2>/dev/null || echo "$DEPLOY_RESPONSE"
echo ""

# Extract deploymentId for subsequent tests
DEPLOYMENT_ID=$(echo "$DEPLOY_RESPONSE" | jq -r '.deploymentId' 2>/dev/null)

if [ -z "$DEPLOYMENT_ID" ] || [ "$DEPLOYMENT_ID" == "null" ]; then
  echo "ERROR: Could not extract deploymentId from response"
  exit 1
fi

echo "✓ Extracted deploymentId: $DEPLOYMENT_ID"
echo ""

# Wait a moment for async deployment to progress
sleep 1

# Test 2: GET /v1/projects/{id}/deployments/{deploymentId} (poll status)
echo "Test 2: GET /v1/projects/{id}/deployments/{deploymentId}"
echo "Expected: 200 OK with deployment status"
echo ""
STATUS_RESPONSE=$(curl -s -X GET \
  "$BASE_URL/v1/projects/$PROJECT_ID/deployments/$DEPLOYMENT_ID" \
  -H "Content-Type: application/json")

echo "Response:"
echo "$STATUS_RESPONSE" | jq . 2>/dev/null || echo "$STATUS_RESPONSE"
echo ""

# Test 3: GET /v1/projects/{id}/deployments/{deploymentId}/events (SSE stream)
echo "Test 3: GET /v1/projects/{id}/deployments/{deploymentId}/events (SSE stream)"
echo "Expected: 200 OK with text/event-stream content-type"
echo "Note: Streaming for 3 seconds..."
echo ""
timeout 3 curl -s -X GET \
  "$BASE_URL/v1/projects/$PROJECT_ID/deployments/$DEPLOYMENT_ID/events" \
  -H "Accept: text/event-stream" || true

echo ""
echo ""

# Test 4: Error cases
echo "Test 4: Error Cases"
echo ""

echo "4a: Missing credentials (400 Bad Request)"
curl -s -X POST \
  "$BASE_URL/v1/projects/$PROJECT_ID/deployments" \
  -H "Content-Type: application/json" \
  -d '{}' | jq . 2>/dev/null || echo "Response error"
echo ""

echo "4b: Invalid instanceUrl (400 Bad Request)"
curl -s -X POST \
  "$BASE_URL/v1/projects/$PROJECT_ID/deployments" \
  -H "Content-Type: application/json" \
  -d '{"accessToken":"token","instanceUrl":"not-a-url"}' | jq . 2>/dev/null || echo "Response error"
echo ""

echo "4c: Non-existent project (404 Not Found)"
curl -s -X POST \
  "$BASE_URL/v1/projects/00000000-0000-0000-0000-000000000000/deployments" \
  -H "Content-Type: application/json" \
  -d "$CREDENTIALS" | jq . 2>/dev/null || echo "Response error"
echo ""

echo "4d: Non-existent deployment (404 Not Found)"
curl -s -X GET \
  "$BASE_URL/v1/projects/$PROJECT_ID/deployments/deploy_nonexistent" | jq . 2>/dev/null || echo "Response error"
echo ""

echo "=== Test Suite Complete ==="
