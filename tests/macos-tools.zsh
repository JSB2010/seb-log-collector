#!/bin/zsh -f
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL EXTENDED_GLOB
TRAPZERR() { print -u2 -- "Native tools fixture failed at ${funcfiletrace[1]:-unknown}"; }
typeset project=${0:A:h:h}
typeset lab=$(/usr/bin/mktemp -d "$project/.local/native-tools.XXXXXXXX")
trap '/bin/rm -rf "$lab"' EXIT
typeset fixture="$lab/fixture-home" root="$lab/.local/collector-test"
/bin/mkdir -p "$fixture/Library/Logs/Safe Exam Browser" "$root/bin/lib" "$root/state" "$root/staging" "$root/credentials"
/bin/cp "$project/collector/soe-diagnostics" "$root/bin/soe-diagnostics"
/bin/cp "$project/collector/read-source" "$root/bin/read-source"
/bin/cp "$project"/collector/lib/*.zsh "$root/bin/lib/"
print -r -- '{"apiOrigin":"https://diagnostics.example.org"}' > "$root/config.json"
SOE_TEST_MODE=1 SOE_TEST_ROOT="$root" /bin/zsh -f "$root/bin/soe-diagnostics" status --json > "$lab/status-test.json"
[[ $(/usr/bin/plutil -extract enrolled raw -o - "$lab/status-test.json") == false ]]
print -r -- 'Synthetic source bytes: apostrophe '\'' quote " spaces and <script>inert</script>' > "$fixture/Library/Logs/Safe Exam Browser/safe fixture.log"
/bin/zsh -f "$project/collector/read-source" read "$fixture" "$EUID" 0 9999999999 'safe fixture.log' > "$lab/snapshot-test.log"
/usr/bin/cmp "$fixture/Library/Logs/Safe Exam Browser/safe fixture.log" "$lab/snapshot-test.log"
/bin/ln -sf 'safe fixture.log' "$fixture/Library/Logs/Safe Exam Browser/link.log"
if /bin/zsh -f "$project/collector/read-source" read "$fixture" "$EUID" 0 9999999999 link.log >/dev/null 2>&1; then print -u2 'Symlink accepted'; exit 1; fi
/bin/rm -f "$fixture/Library/Logs/Safe Exam Browser/link.log"
/bin/ln "$fixture/Library/Logs/Safe Exam Browser/safe fixture.log" "$fixture/Library/Logs/Safe Exam Browser/hard.log"
if /bin/zsh -f "$project/collector/read-source" read "$fixture" "$EUID" 0 9999999999 hard.log >/dev/null 2>&1; then print -u2 'Hard link accepted'; exit 1; fi
/bin/rm -f "$fixture/Library/Logs/Safe Exam Browser/hard.log"
/usr/bin/mkfifo "$fixture/Library/Logs/Safe Exam Browser/fifo.log"
if /bin/zsh -f "$project/collector/read-source" read "$fixture" "$EUID" 0 9999999999 fifo.log >/dev/null 2>&1; then print -u2 'FIFO accepted'; exit 1; fi
/bin/rm -f "$fixture/Library/Logs/Safe Exam Browser/fifo.log"
/usr/bin/gzip -n -1 -c "$lab/snapshot-test.log" > "$lab/snapshot-test.gz"
/usr/bin/gzip -dc "$lab/snapshot-test.gz" | /usr/bin/cmp - "$lab/snapshot-test.log"
# Exercise schema creation, SQL escaping and secret-free status on real SQLite/plutil.
SOE_TEST_MODE=1 SOE_TEST_ROOT="$root" /bin/zsh -f "$root/bin/soe-diagnostics" tick
[[ $(/usr/bin/sqlite3 "$root/state/ledger.sqlite" 'PRAGMA user_version;') == 1 ]]
/usr/bin/plutil -lint "$project/collector/org.soe.diagnostics.collector.plist"
# A failed terminal report survives a tick, then retries before its request ack.
typeset ROOT="$root" STATE="$root/state"
source "$project/collector/lib/common.zsh"
source "$project/collector/lib/ledger.zsh"
source "$project/collector/lib/collection.zsh"
WORK=$(/usr/bin/mktemp -d "$STATE/test-report.XXXXXXXX")
source "$project/collector/lib/metadata.zsh"
typeset VERSION=synthetic
metadata "$WORK/native-metadata.json"
[[ $(json_value "$WORK/native-metadata.json" collectorVersion) == synthetic && -n $(json_value "$WORK/native-metadata.json" timezone) ]]
METADATA="$WORK/metadata.json"; print -r -- '{"collectorVersion":"synthetic"}' > "$METADATA"
COLLECTION_ID=$(/usr/bin/uuidgen); COLLECTION_ID=${COLLECTION_ID:l}
REQUEST_ID=$(/usr/bin/uuidgen); REQUEST_ID=${REQUEST_ID:l}
COLLECTION_REASON=on_demand; COLLECTION_STARTED=$(utc)
http() { HTTP_CODE=503; return 1; }
if collection_report failed; then print -u2 'Offline terminal report unexpectedly sent'; exit 1; fi
[[ -f "$STATE/reports/$COLLECTION_ID.json" ]]
http() { HTTP_CODE=200; [[ $2 != */ack ]] || print -r -- "$3" > "$WORK/ack.json"; return 0; }
flush_reports
[[ ! -f "$STATE/reports/$COLLECTION_ID.json" ]]
[[ $(json_value "$WORK/ack.json" state) == failed ]]
metadata() { print -r -- '{"collectorVersion":"synthetic"}' > "$1"; }
scan() { SCAN_OUTCOME=no_logs; return 0; }
retry_staged() { return 0; }
run_collection on_demand 0 9999999999
typeset first_collection=$COLLECTION_ID
run_collection on_demand 0 9999999999
[[ $COLLECTION_ID == $first_collection ]]
# Rotation bounds active and archived collector logs without touching source logs.
/bin/mkdir -p "$ROOT/logs"
/bin/dd if=/dev/zero of="$ROOT/logs/collector.log" bs=1048576 count=3 2>/dev/null
SOE_TEST_MODE=1 rotate_logs
[[ $(/usr/bin/stat -f '%z' "$ROOT/logs/collector.log") == 0 ]]
[[ $(/usr/bin/stat -f '%z' "$ROOT/logs/collector.1.log") == 2097152 ]]
/bin/rm -rf "$WORK"
# Open enrollment retries the same private code until accepted or explicitly closed.
source "$project/collector/lib/enrollment.zsh"
typeset pending="$STATE/enrollment-bootstrap"
print -rn -- 'synthetic-pending-code' > "$pending"
enroll() { [[ $(/bin/cat) == 'synthetic-pending-code' ]]; return 1; }
if retry_enrollment; then print -u2 'Pending enrollment unexpectedly succeeded'; exit 1; fi
[[ -f $pending ]]
touch -t 200001010000 "$pending"
if retry_enrollment; then print -u2 'Pending enrollment unexpectedly succeeded'; exit 1; fi
[[ -f $pending ]]
/bin/rm -f "$pending"
# Pausing collection must not prevent lifecycle commands from reaching the Mac.
source "$project/collector/lib/management.zsh"
WORK=$(/usr/bin/mktemp -d "$STATE/test-control.XXXXXXXX")
typeset CREDS="$ROOT/credentials/device.json" controls=0 deferred=0
print '{"deviceId":"fixture"}' > "$CREDS"
print paused > "$STATE/paused"
http() {
  HTTP_CODE=200; HTTP_RESPONSE="$WORK/control.json"
  if [[ $1 == GET && $2 == /api/device/v1/config ]]; then
    controls=$((controls+1))
    print '{"paused":true,"commands":[{"id":"00000000-0000-4000-a000-000000000001","action":"update"}]}' > "$HTTP_RESPONSE"
  elif [[ $2 == */ack ]]; then
    [[ $3 == '{"state":"deferred","result":"busy"}' ]]
    deferred=$((deferred+1))
  else return 1; fi
}
seb_running() { return 0; }
tick tick
[[ $controls == 1 && $deferred == 1 && $(<"$STATE/outcome") == deferred ]]
typeset managed=0
seb_running() { return 1; }
management_command() { managed=$((managed+1)); return 0; }
tick tick
[[ $controls == 2 && $managed == 1 ]]
/bin/rm -rf "$WORK"
print 'macOS tool checks passed: JSON, stable FD snapshot, spaces, symlinks, hard links, FIFO rejection, gzip, ledger, unenrolled tick, report recovery/failed ack, request replay, log rotation, persistent pending enrollment, paused control check-in and exam deferral, plist.'
