#!/usr/bin/env bash
# Phase L handshake probe — verifies every credential-free external link.
# Exit 0 = all green. Any failure prints the broken link and exits 1.
# (Links that need secrets — worker DATABASE_URL, backend host, AI keys — are
# verified by their own runtimes: the Actions workflows fail loudly, and
# /api/health covers the backend once deployed.)
set -uo pipefail
fail=0
green=0
total=0

check() { # name url extra_curl_args...
  local name="$1" url="$2"; shift 2
  local code
  total=$((total + 1))
  code=$(curl -sS -m 20 -o /dev/null -w "%{http_code}" "$@" "$url" 2>/dev/null)
  if [ "$code" = "200" ]; then echo "GREEN  $name ($code)"; green=$((green + 1)); else echo "RED    $name ($code)"; fail=1; fi
}

SUPA="https://hvsvxjdwfbsqaqlmuwlt.supabase.co"
# Public anon key — safe in source by design (RLS enforced); same key ships in the client bundle.
ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh2c3Z4amR3ZmJzcWFxbG11d2x0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1Mzc0NjAsImV4cCI6MjA5MDExMzQ2MH0.OLh3JihHms6aUxE3GR9OErpobj_0mIiewXTwxG-pP8M"

check "supabase-rpc-health" "$SUPA/rest/v1/rpc/api_health" \
  -X POST -H "Content-Type: application/json" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -d '{}'
check "netlify-frontend" "https://buyerdb.netlify.app/"
check "socrata-acris" "https://data.cityofnewyork.us/resource/bnx9-e6tj.json?\$limit=1"

echo "----"
echo "$green/$total green"
exit $fail
