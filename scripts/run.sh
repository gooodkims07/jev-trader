#!/bin/sh
# Run the bot, and start it again when it exits with 75: the dashboard asked for a restart (e.g. a new coin,
# saved to data/settings.json). Any other exit ends this script too. SIGTERM/SIGINT stop the bot and the loop.
#   nohup scripts/run.sh >> data/spike-run.log 2>&1 &   then   kill <pid of run.sh>
cd "$(dirname "$0")/.." || exit 1
export JEV_SUPERVISED=1
child=""
trap 'if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; wait "$child"; fi; exit 0' TERM INT
while :; do
  bun run src/index.ts &
  child=$!
  wait "$child"
  code=$?
  child=""
  [ "$code" -eq 75 ] || exit "$code"
  echo "run.sh: restarting (settings changed)"
  sleep 1
done
