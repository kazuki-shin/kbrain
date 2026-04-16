#!/bin/bash
# quiet-hours-gate.sh — run before any notification cron job
#
# Usage:
#   if ! bash scripts/quiet-hours-gate.sh; then
#     mkdir -p /tmp/cron-held
#     echo "$OUTPUT" > /tmp/cron-held/$(basename "$0" .sh).md
#     exit 0
#   fi
#
# Exit 1 = quiet hours (hold notifications)
# Exit 0 = active hours (ok to send)

TIMEZONE="${USER_TIMEZONE:-US/Pacific}"

# Travel-aware: check if a recent HEARTBEAT.md records a different timezone
HEARTBEAT="${HOME}/.gbrain/HEARTBEAT.md"
if [ -f "$HEARTBEAT" ]; then
  DETECTED_TZ=$(grep -m1 "^timezone:" "$HEARTBEAT" | awk '{print $2}')
  if [ -n "$DETECTED_TZ" ]; then
    TIMEZONE="$DETECTED_TZ"
  fi
fi

LOCAL_HOUR=$(TZ="$TIMEZONE" date +%H)
QUIET_START="${QUIET_START:-23}"
QUIET_END="${QUIET_END:-8}"

if [ "$LOCAL_HOUR" -ge "$QUIET_START" ] || [ "$LOCAL_HOUR" -lt "$QUIET_END" ]; then
  echo "QUIET_HOURS=true (local=${LOCAL_HOUR}h TZ=${TIMEZONE})"
  exit 1  # quiet hours — hold the notification
fi

echo "QUIET_HOURS=false (local=${LOCAL_HOUR}h TZ=${TIMEZONE})"
exit 0   # active hours — ok to send
