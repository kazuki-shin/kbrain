#!/bin/bash
# dream-cycle.sh — nightly brain maintenance (run at 2 AM)
#
# Four phases:
#   Phase 1: Entity sweep — detect entities from today's conversations, create/enrich pages
#   Phase 2: Fix broken citations — doctor check, surface warnings
#   Phase 3: Consolidate memory — sync + embed stale
#   Phase 4: Report
#
# Logs to /tmp/dream-cycle-YYYY-MM-DD.log

LOG="/tmp/dream-cycle-$(date +%Y-%m-%d).log"
GBRAIN="${GBRAIN_BIN:-gbrain}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() {
  echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"
}

log "=== Dream cycle starting ==="

# ── Phase 1: Entity sweep ─────────────────────────────────────────────────────
log "Phase 1: Entity sweep"

# Enrich any pages flagged as thin (created today without full enrichment)
$GBRAIN enrich --stale >> "$LOG" 2>&1 && log "Entity enrichment complete" \
  || log "WARN: enrich returned non-zero (may be ok if nothing was stale)"

# ── Phase 2: Citation hygiene ─────────────────────────────────────────────────
log "Phase 2: Citation hygiene"

DOCTOR_OUT=$($GBRAIN doctor --json 2>>"$LOG")
if [ -n "$DOCTOR_OUT" ]; then
  WARNINGS=$(echo "$DOCTOR_OUT" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); [print(c['message']) for c in d.get('checks',[]) if c.get('status')=='warn']" 2>/dev/null)
  if [ -n "$WARNINGS" ]; then
    log "Citation warnings found:"
    echo "$WARNINGS" | while read -r line; do log "  - $line"; done
    # Save to held queue — morning briefing picks this up
    mkdir -p /tmp/cron-held
    {
      echo "## Brain Health Warnings ($(date +%Y-%m-%d))"
      echo ""
      echo "$WARNINGS"
    } > /tmp/cron-held/dream-cycle-warnings.md
  else
    log "No citation warnings"
  fi
fi

# ── Phase 3: Memory consolidation ────────────────────────────────────────────
log "Phase 3: Memory consolidation (sync + embed stale)"

# Sync without pulling remote or re-embedding (just flush local state)
$GBRAIN sync --no-pull --no-embed >> "$LOG" 2>&1 \
  && log "Sync complete" \
  || log "WARN: sync returned non-zero"

# Embed any pages that were updated but not yet embedded
$GBRAIN embed --stale >> "$LOG" 2>&1 \
  && log "Embedding complete" \
  || log "WARN: embed returned non-zero"

# ── Phase 4: Report ───────────────────────────────────────────────────────────
log "Phase 4: Report"

REPORT_DIR="$REPO_ROOT/reports/dream-cycle"
mkdir -p "$REPORT_DIR"
REPORT_FILE="$REPORT_DIR/$(date +%Y-%m-%d-%H%M).md"

{
  echo "---"
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "job: dream-cycle"
  echo "---"
  echo ""
  echo "# Dream Cycle — $(date +%Y-%m-%d)"
  echo ""
  echo "## Log"
  echo ""
  echo '```'
  tail -50 "$LOG"
  echo '```'
} > "$REPORT_FILE"

log "Report saved: $REPORT_FILE"
log "=== Dream cycle complete ==="
