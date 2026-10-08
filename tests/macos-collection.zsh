#!/bin/zsh -f
# Exercise the actual snapshot/ledger/retry/ack path with native Mac tools.
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL EXTENDED_GLOB
umask 077
typeset project=${0:A:h:h}
typeset lab=$(/usr/bin/mktemp -d "$project/.local/collection-fixture.XXXXXXXX")
trap '/bin/rm -rf "$lab"' EXIT
typeset ROOT="$lab/root" STATE="$lab/root/state" STAGE="$lab/root/staging" BIN="$project/collector"
typeset fixture="$lab/home" name="fixture's backslash\\.log" VERSION=synthetic
/bin/mkdir -p "$STATE" "$STAGE" "$fixture/Library/Logs/Safe Exam Browser"
source "$project/collector/lib/common.zsh"
source "$project/collector/lib/ledger.zsh"
source "$project/collector/lib/collection.zsh"
ledger_init
WORK="$lab/work"; /bin/mkdir "$WORK"
METADATA="$WORK/metadata.json"
json_new "$METADATA"
json_string "$METADATA" computerName "Fixture's Mac \\ unicode ☃"
json_string "$METADATA" collectorVersion synthetic
COLLECTION_ID=$(/usr/bin/uuidgen); COLLECTION_ID=${COLLECTION_ID:l}
COLLECTION_REASON=initial
print -r -- 'Synthetic source bytes; no real student or exam data.' > "$fixture/Library/Logs/Safe Exam Browser/$name"
reader() { local user=$1; shift; /bin/zsh -f "$BIN/read-source" "$@"; }
has_budget() { return 0; }
seb_running() { return 1; }
# A compression result can survive a crash before its ledger INSERT commits.
typeset hash=$(hash_file "$fixture/Library/Logs/Safe Exam Browser/$name")
/usr/bin/gzip -n -1 -c "$fixture/Library/Logs/Safe Exam Browser/$name" > "$STAGE/$hash.gz"
[[ $(ledger_sql 'SELECT count(*) FROM uploads;') == 0 ]]
snapshot "$USER" "$fixture" "$EUID" "$name" 0 9999999999
[[ $(ledger_sql 'SELECT count(*) FROM uploads;') == 1 ]]
[[ $(ledger_sql "SELECT json_extract(metadata_json,'$.computerName') FROM uploads;") == "Fixture's Mac \\ unicode ☃" ]]
[[ $(ledger_sql "SELECT json_extract(source_json,'$.basename') FROM uploads;") == "$name" ]]
# Quote-like input is data, including repeated quotes, Unicode and backslashes.
typeset value="''); DROP TABLE uploads; -- \\ ☃"
save_setting "quoted'key" "$value"
[[ $(setting "quoted'key") == "$value" && $(ledger_sql 'SELECT count(*) FROM uploads;') == 1 ]]
# A failed acknowledgment commit must preserve the only staged copy.
print -r -- "{\"acknowledgment\":{\"rawSha256\":\"$hash\"}}" > "$WORK/ack.json"
/bin/chmod 400 "$LEDGER"
if confirm_row "$hash" "$WORK/ack.json" 2> "$WORK/sql-error.txt"; then print -u2 'Read-only ledger confirmation unexpectedly succeeded'; exit 1; fi
[[ -f "$STAGE/$hash.gz" && $(<"$STATE/last-error") == ledger_error ]]
[[ $(<"$WORK/sql-error.txt") == *'ledger operation failed'* && $(<"$WORK/sql-error.txt") != *'Fixture'* ]]
/bin/chmod 600 "$LEDGER"
# Expiry cannot discard a tracked payload if its state update fails either.
ledger_sql 'UPDATE uploads SET created_at=0;'
/bin/chmod 400 "$LEDGER"
if stage_cleanup 2> "$WORK/sql-error.txt"; then print -u2 'Read-only ledger cleanup unexpectedly succeeded'; exit 1; fi
[[ -f "$STAGE/$hash.gz" ]]
/bin/chmod 600 "$LEDGER"
ledger_sql "UPDATE uploads SET created_at=$(/bin/date +%s);"
typeset upload_id=$(/usr/bin/uuidgen); upload_id=${upload_id:l}
typeset prepared=0 completed=0 uploaded=0
http() {
  HTTP_CODE=200; HTTP_RESPONSE="$WORK/mock-response.json"
  case $2 in
    /api/device/v1/uploads/prepare)
      prepared=$((prepared+1)); print -rn -- "$3" > "$WORK/prepare-request.json"
      [[ $(json_value "$WORK/prepare-request.json" metadata.computerName) == "Fixture's Mac \\ unicode ☃" ]]
      print -r -- "{\"state\":\"reserved\",\"uploadId\":\"$upload_id\"}" > "$HTTP_RESPONSE" ;;
    /api/device/v1/uploads/$upload_id/complete)
      completed=$((completed+1)); print -r -- "{\"acknowledgment\":{\"rawSha256\":\"$hash\"}}" > "$HTTP_RESPONSE" ;;
    *) return 1 ;;
  esac
}
post_gcs() {
  /usr/bin/gzip -dc "$2" | /usr/bin/cmp - "$fixture/Library/Logs/Safe Exam Browser/$name"
  uploaded=$((uploaded+1)); HTTP_CODE=201
}
retry_staged
[[ $prepared == 1 && $completed == 1 && $uploaded == 1 && $CONFIRMED == 1 ]]
[[ $(ledger_sql 'SELECT state FROM uploads;') == confirmed && ! -e "$STAGE/$hash.gz" ]]
# Daily stat-cache dedup must not re-stage the same confirmed source.
snapshot "$USER" "$fixture" "$EUID" "$name" 0 9999999999
[[ $SKIPPED == 1 && ! -e "$STAGE/$hash.gz" ]]
# Untracked payloads and incomplete compression are bounded independently of SQL.
typeset empty=''
typeset orphan_old=${(l:64::a:)empty} orphan_recent=${(l:64::b:)empty}
print stale > "$STAGE/$orphan_old.gz"; print recent > "$STAGE/$orphan_recent.gz"
print partial > "$STAGE/$orphan_old.gz.tmp"
/usr/bin/touch -t 200001010000 "$STAGE/$orphan_old.gz" "$STAGE/$orphan_old.gz.tmp"
stage_cleanup
[[ ! -e "$STAGE/$orphan_old.gz" && ! -e "$STAGE/$orphan_old.gz.tmp" && -e "$STAGE/$orphan_recent.gz" ]]
print 'Native collection checks passed: orphan recovery/expiry, apostrophes/backslashes/Unicode, SQL-like data, preserved payload on ledger failure, safe errors, snapshot, prepare, gzip upload, acknowledgment and dedup.'
