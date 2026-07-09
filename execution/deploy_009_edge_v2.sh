#!/usr/bin/env bash
# Compatibility wrapper retained so old runbooks do not point at a dead file.
# The current live Supabase project is the SBI deployment, so the correct
# operation is production verification, not applying the old hvsv 009/edge stack.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/execution/verify_live_sbi.sh"
