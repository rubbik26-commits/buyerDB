#!/usr/bin/env bash
set -euo pipefail

AUDIENCE="buyerdb-netlify-deploy"
REQUEST_URL="${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${AUDIENCE}"
IDENTITY=$(curl -fsS -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" "$REQUEST_URL" | jq -r '.value')
test -n "$IDENTITY" && test "$IDENTITY" != "null"

RESPONSE=$(jq -n --arg token "$IDENTITY" '{token:$token}' | curl -fsS -X POST \
  "https://pdvyuepsdnpxctmagdcq.supabase.co/functions/v1/github-netlify-proxy" \
  -H 'Content-Type: application/json' --data-binary @-)
PROXY_URL=$(jq -r '.proxy_url // empty' <<<"$RESPONSE")
export VITE_API_URL=$(jq -r '.vite_api_url // empty' <<<"$RESPONSE")
export VITE_SUPABASE_ANON_KEY=$(jq -r '.vite_anon_key // empty' <<<"$RESPONSE")
export VITE_USE_SUPABASE_RPC=$(jq -r '.vite_rpc_mode // empty' <<<"$RESPONSE")
test -n "$PROXY_URL"
test -n "$VITE_API_URL"
test -n "$VITE_SUPABASE_ANON_KEY"

SITE_ID="e1780534-ba0b-470e-b98f-85b29f7d32a1"
NOAUTH_STATUS=$(curl -sS -o /tmp/netlify-site-noauth.json -w '%{http_code}' "$PROXY_URL/api/v1/sites/$SITE_ID")
DUMMY_STATUS=$(curl -sS -o /tmp/netlify-site-dummy.json -w '%{http_code}' -H 'Authorization: Bearer oidc-proxy' "$PROXY_URL/api/v1/sites/$SITE_ID")
echo "NETLIFY_PROXY_STATUS noauth=$NOAUTH_STATUS dummy=$DUMMY_STATUS"

export NETLIFY_API_URL="${PROXY_URL}/api/v1"
export NETLIFY_DEPLOY_SOURCE="cli"

cd skyline/frontend
npm ci
npm run build
npm install --no-save @netlify/functions@latest

! grep -rqiE "sk-[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{16,}|postgres(ql)?://|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY|sb_secret_|SCRAPERAPI_KEY|APIFY_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY" dist/ \
  || { echo "SERVER SECRET FOUND IN FRONTEND BUNDLE"; exit 1; }

npx --yes netlify-cli@26.2.0 deploy \
  --prod \
  --json \
  --dir=dist \
  --functions=netlify/functions \
  --site="$SITE_ID" \
  --auth=oidc-proxy \
  --message="verified direct production deploy" | tee /tmp/netlify-direct-deploy.json

DEPLOY_URL=$(jq -r '.deploy_url // .url // .ssl_url // empty' /tmp/netlify-direct-deploy.json)
test -n "$DEPLOY_URL"
payload='{"question":"Who is the best buyer for a Brooklyn multifamily around $3M?"}'
for i in $(seq 1 30); do
  curl -fsS -X POST "$DEPLOY_URL/api/agent" -H 'Content-Type: application/json' -d "$payload" > /tmp/agent.json || true
  if jq -e '.tool == "find_similar_buyers" and (.result.candidates | length) > 0' /tmp/agent.json >/dev/null 2>&1; then
    cat /tmp/agent.json
    exit 0
  fi
  sleep 3
done
cat /tmp/agent.json || true
exit 1
