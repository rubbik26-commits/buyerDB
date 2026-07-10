#!/usr/bin/env bash
set -o pipefail
bash scripts/direct_netlify_publish.sh 2>&1 | tee /tmp/direct-publish.log
exit ${PIPESTATUS[0]}
