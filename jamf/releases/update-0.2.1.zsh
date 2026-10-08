#!/bin/zsh -f
# Shared lifecycle guard. Included in generated installer / uninstaller payloads.
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL EXTENDED_GLOB
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
typeset -r ROOT='/Library/Application Support/SOEDiagnostics' LABEL='org.soe.diagnostics.collector' PLIST='/Library/LaunchDaemons/org.soe.diagnostics.collector.plist' LOGS='/Library/Logs/SOEDiagnostics'
[[ $EUID == 0 ]] || { print -u2 'Root required'; exit 1; }
safe_path() {
  local input=$1 part current=''
  for part in ${(s:/:)input}; do [[ -z $part ]] || { current="$current/$part"; [[ ! -L $current ]] || { print -u2 'Unsafe symlink in owned path'; exit 1; }; }; done
}
for p in "$ROOT" "$PLIST" "$LOGS"; do safe_path "$p"; done
stop_job() {
  /bin/launchctl bootout "system/$LABEL" 2>/dev/null || true
  if /bin/launchctl print "system/$LABEL" >/dev/null 2>&1; then print -u2 'Collector job still loaded'; return 1; fi
  # Only processes executing our fixed project path are eligible for termination.
  local pid args seconds=0
  while (( seconds < 15 )); do
    local running=0
    for pid in ${(@f)$(/usr/bin/pgrep -f '/Library/Application Support/SOEDiagnostics/bin/(soe-diagnostics|read-source)' 2>/dev/null || true)}; do
      args=$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)
      if [[ $args == '/bin/zsh -f /Library/Application Support/SOEDiagnostics/bin/soe-diagnostics'* || $args == '/bin/zsh -f /Library/Application Support/SOEDiagnostics/bin/read-source'* ]]; then /bin/kill -TERM "$pid" 2>/dev/null || true; running=1; fi
    done
    (( running == 0 )) && return 0
    /bin/sleep 1; seconds=$((seconds+1))
  done
  print -u2 'Collector processes remain; removal stopped'; return 1
}

# Validate native prerequisites before replacing an installed collector.
for native_tool in /bin/cat /bin/chmod /bin/cp /bin/date /bin/dd /bin/df /bin/kill /bin/launchctl /bin/mkdir /bin/mv /bin/ps /bin/rm /bin/sleep /bin/zsh /usr/bin/awk /usr/bin/curl /usr/bin/dscl /usr/bin/du /usr/bin/env /usr/bin/find /usr/bin/gzip /usr/bin/mktemp /usr/bin/openssl /usr/bin/pgrep /usr/bin/plutil /usr/bin/pmset /usr/bin/readlink /usr/bin/sed /usr/bin/shasum /usr/bin/sqlite3 /usr/bin/stat /usr/bin/sudo /usr/bin/sw_vers /usr/bin/tail /usr/bin/touch /usr/bin/tr /usr/bin/uname /usr/bin/uuidgen /usr/sbin/chown /usr/sbin/ioreg /usr/sbin/scutil /usr/sbin/sysctl; do
  [[ -x $native_tool ]] || { print -u2 "Missing required native tool: $native_tool"; exit 1; }
done

[[ -f "$ROOT/config.json" ]] || { print 'No installed collector to update'; exit 0; }
# Set API_ORIGIN in your IT-controlled copy. Updates preserve existing configuration.
API_ORIGIN=${API_ORIGIN:-}
if [[ ! -f "$ROOT/config.json" ]]; then
  [[ $API_ORIGIN == https://* && $API_ORIGIN != *[$'\n\r\t \"\\']* && ${API_ORIGIN#https://} != */* && ${API_ORIGIN#https://} != *[@?#]* ]] || { print -u2 'Set a valid HTTPS API_ORIGIN before first install'; exit 1; }
fi
/bin/mkdir -p "$ROOT" "$LOGS" "$ROOT/credentials" "$ROOT/state" "$ROOT/staging"
for p in "$ROOT/bin" "$ROOT/support" "$ROOT/previous" "$ROOT/credentials" "$ROOT/state" "$ROOT/staging"; do safe_path "$p"; done
incoming=$(/usr/bin/mktemp -d "$ROOT/.incoming.XXXXXXXX")
trap '/bin/rm -rf "$incoming"' EXIT
/bin/mkdir -p "$incoming/bin/lib" "$incoming/support"

# bin/soe-diagnostics
/bin/cat > "$incoming/bin/soe-diagnostics" <<'SOE_FILE_d2145b4d91b4ed152137108f'
#!/bin/zsh -f
# Copyright (c) Safe Online Exam Logs contributors. MIT licensed.
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL EXTENDED_GLOB
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset CDPATH ENV BASH_ENV
typeset -r VERSION=0.2.1
typeset ROOT='/Library/Application Support/SOEDiagnostics'
if [[ ${SOE_TEST_MODE:-0} == 1 && $EUID != 0 && ${SOE_TEST_ROOT:-} == */.local/collector-test ]]; then ROOT=$SOE_TEST_ROOT; else [[ $EUID == 0 ]] || { print -u2 'Root required'; exit 1; }; fi
typeset -r BIN="$ROOT/bin" STATE="$ROOT/state" STAGE="$ROOT/staging" CREDS="$ROOT/credentials/device.json" CONFIG="$ROOT/config.json"
for dir in "$ROOT" "$BIN" "$STATE" "$STAGE" "$ROOT/credentials"; do [[ -d $dir && ! -L $dir ]] || { print -u2 'Collector path missing or unsafe'; exit 1; }; done
for mod in common http ledger metadata enrollment collection; do
  [[ -f "$BIN/lib/$mod.zsh" && ! -L "$BIN/lib/$mod.zsh" ]] || exit 1
  source "$BIN/lib/$mod.zsh"
done
tool_check
typeset CMD=${1:-tick}; shift || true
case $CMD in
  status) status_json ;;
  pause) /usr/bin/touch "$STATE/paused"; print 'Locally paused' ;;
  resume) /bin/rm -f "$STATE/paused"; print 'Local pause removed' ;;
  prepare-uninstall) /usr/bin/touch "$STATE/stopping"; WORK=$(/usr/bin/mktemp -d "$STATE/work.XXXXXXXX"); trap cleanup EXIT; if [[ -f $CREDS ]]; then http POST /api/device/v1/deactivate '{}' 10 || true; fi; print 'Prepared for removal' ;;
  tick|collect|enroll)
    acquire_lock || exit 0
    trap cleanup EXIT
    trap 'exit 143' TERM INT
    ledger_init
    rotate_logs
    if [[ $CMD == enroll ]]; then [[ ${1:-} == --bootstrap-stdin ]] || die bootstrap_stdin_required; enroll
    else [[ $CMD != collect || ${1:-} == --now ]] || die invalid_collect_option; tick $([[ $CMD == collect ]] && print on_demand || print daily)
    fi ;;
  *) print -u2 'Commands: tick, status --json, collect --now, enroll --bootstrap-stdin, pause, resume, prepare-uninstall'; exit 2 ;;
esac
SOE_FILE_d2145b4d91b4ed152137108f
[[ $(/usr/bin/shasum -a 256 < "$incoming/bin/soe-diagnostics" | /usr/bin/awk '{print $1}') == 'd2145b4d91b4ed152137108fb956bbb7822845ea65498700e92e16c2e3eda4ce' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/bin/soe-diagnostics"

# bin/read-source
/bin/cat > "$incoming/bin/read-source" <<'SOE_FILE_18b6fda135e1a68980130f0b'
#!/bin/zsh -f
# This helper runs as the source user. It never sees device credentials.
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL EXTENDED_GLOB
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
typeset mode=${1:?} user_home=${2:?} uid=${3:?} minimum=${4:?} maximum=${5:?} basename=${6:-}
[[ $EUID == $uid && $uid == <-> && $uid -ge 501 && $user_home == /Users/* && $user_home != *'/../'* ]] || exit 2
typeset dir="$user_home/Library/Logs/Safe Exam Browser" ancestor="$user_home"
for component in Library Logs 'Safe Exam Browser'; do [[ ! -L $ancestor ]] || exit 3; ancestor="$ancestor/$component"; done
[[ ! -L $dir && -d $dir ]] || exit 4
safe() { local p=$1; [[ -f $p && ! -L $p && $(/usr/bin/stat -f '%u:%l' "$p") == "$uid:1" ]] || return 1; }
if [[ $mode == list ]]; then
  count=0
  for p in "$dir/"*.log(N); do
    name=${p:t}; [[ ${#name} -le 200 && $name != *[$'\n\r\t']* && $name != .* ]] || continue
    safe "$p" || continue
    mtime=$(/usr/bin/stat -f '%m' "$p"); [[ $mtime -ge $minimum && $mtime -le $maximum ]] || continue
    print -r -- "$name"; count=$((count+1)); (( count < 1000 )) || break
  done
elif [[ $mode == read ]]; then
  [[ -n $basename && $basename != */* && $basename != .* && $basename != *[$'\n\r\t']* ]] || exit 2
  p="$dir/$basename"; safe "$p" || exit 3
  before=$(/usr/bin/stat -f '%d:%i:%z:%m:%u:%l' "$p"); size=$(/usr/bin/stat -f '%z' "$p")
  [[ $size -gt 0 && $size -le 67108864 ]] || exit 5
  # The descriptor pins this snapshot. Opening a hostile FIFO race is bounded by
  # the coordinator watchdog, while user credentials constrain readable files.
  exec {fd}< "$p"
  opened=$(/usr/bin/stat -Lf '%i:%z:%m:%u:%l' "/dev/fd/$fd")
  [[ $opened == ${before#*:} ]] || exit 3
  /bin/dd bs=65536 count=$(( (size+65535)/65536 )) <&$fd 2>/dev/null
  after=$(/usr/bin/stat -Lf '%i:%z:%m:%u:%l' "/dev/fd/$fd")
  exec {fd}<&-
  [[ ${before#*:} == $after && $before == $(/usr/bin/stat -f '%d:%i:%z:%m:%u:%l' "$p") ]] || exit 6
else exit 2; fi
SOE_FILE_18b6fda135e1a68980130f0b
[[ $(/usr/bin/shasum -a 256 < "$incoming/bin/read-source" | /usr/bin/awk '{print $1}') == '18b6fda135e1a68980130f0b1c44a051ec196e114ecd0737de9d458d97811397' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/bin/read-source"

# bin/lib/collection.zsh
/bin/cat > "$incoming/bin/lib/collection.zsh" <<'SOE_FILE_e49e67248534477ebea47aca'
typeset COLLECTION_ID='' REQUEST_ID='' METADATA='' FOUND=0 CONFIRMED=0 FAILED=0 SKIPPED=0 SCAN_OUTCOME=no_logs RUN_BYTES=0
flush_reports() {
  local report outcome request ack n=0
  [[ -d "$STATE/reports" && ! -L "$STATE/reports" ]] || return 0
  /usr/bin/find "$STATE/reports" -type f -name '*.json' -mtime +7 -delete
  for report in "$STATE/reports"/*.json(N); do
    (( n++ < 10 )) || break
    [[ ! -L $report ]] || continue
    http POST /api/device/v1/collections "$(as_json "$report")" || return 1
    request=$(json_value "$report" requestId || true)
    if [[ -n $request ]]; then
      outcome=$(json_value "$report" outcome)
      case $outcome in deferred) ack=deferred ;; failed|unreadable|disk_pressure) ack=failed ;; *) ack=completed ;; esac
      if ! http POST "/api/device/v1/requests/$request/ack" "{\"state\":\"$ack\"}"; then
        [[ $HTTP_CODE == 404 || $HTTP_CODE == 410 ]] || return 1
      fi
    fi
    /bin/rm -f "$report"
  done
}
collection_report() {
  local outcome=$1 f="$WORK/collection.json"
  json_new "$f"; json_int "$f" schemaVersion 1; json_string "$f" collectionId "$COLLECTION_ID"; json_string "$f" reason "$COLLECTION_REASON"; json_string "$f" startedAt "$COLLECTION_STARTED"; [[ $outcome == running ]] || json_string "$f" endedAt "$(utc)"; json_string "$f" outcome "$outcome"
  [[ -z $REQUEST_ID ]] || json_string "$f" requestId "$REQUEST_ID"
  json_object "$f" metadata "$METADATA"; /usr/bin/plutil -insert counts -json '{"found":0,"confirmed":0,"failed":0,"skipped":0}' "$f"
  /usr/bin/plutil -replace counts.found -integer "$FOUND" "$f"; /usr/bin/plutil -replace counts.confirmed -integer "$CONFIRMED" "$f"; /usr/bin/plutil -replace counts.failed -integer "$FAILED" "$f"; /usr/bin/plutil -replace counts.skipped -integer "$SKIPPED" "$f"
  if [[ $outcome == running ]]; then
    http POST /api/device/v1/collections "$(as_json "$f")"
  else
    /bin/mkdir -p "$STATE/reports"
    atomic_json "$f" "$STATE/reports/$COLLECTION_ID.json"
    flush_reports
  fi
}
ack_request() { [[ -z $REQUEST_ID ]] || http POST "/api/device/v1/requests/$REQUEST_ID/ack" "{\"state\":\"$1\"}"; }
has_budget() { (( SECONDS-COLLECTOR_START < 270 )) && [[ ! -f "$STATE/stopping" ]] && ! seb_running; }
stage_cleanup() {
  local hash expired known_state staged
  expired=$(ledger_sql "SELECT raw_hash FROM uploads WHERE state!='confirmed' AND created_at < $(($( /bin/date +%s)-604800));") || return 1
  for hash in ${(@f)expired}; do
    [[ $hash == [a-f0-9]## && ${#hash} == 64 ]] || continue
    ledger_sql "UPDATE uploads SET state='discovered',last_error='staging_evicted',retry_at=0 WHERE raw_hash=$(sql_quote "$hash");" || return 1
    /bin/rm -f "$STAGE/$hash.gz"
  done
  /usr/bin/find "$STAGE" -type f -name '*.raw' -mtime +1 -delete
  /usr/bin/find "$STAGE" -type f -name '*.gz.tmp' -mtime +1 -delete
  # Crashes between compression and the ledger INSERT can leave orphan payloads.
  # Keep recent ones for source rediscovery; bound those no longer discoverable.
  for staged in "$STAGE"/*.gz(N); do
    hash=${staged:t:r}
    [[ ! -L $staged && $hash == [a-f0-9]## && ${#hash} == 64 ]] || continue
    known_state=$(ledger_sql "SELECT state FROM uploads WHERE raw_hash=$(sql_quote "$hash");") || return 1
    if [[ -z $known_state ]] && (( $(/bin/date +%s)-$(/usr/bin/stat -f '%m' "$staged") > 604800 )); then /bin/rm -f "$staged"; fi
  done
  ledger_sql "DELETE FROM settings WHERE key LIKE 'request_%' AND CAST(substr(value,38) AS INTEGER) < $(($( /bin/date +%s)-604800));"
}
upload_one() {
  local hash=$1 f="$WORK/prepare.json" state uploadid r rowfile="$WORK/row.json"
  [[ $hash == [a-f0-9]## && ${#hash} == 64 && -f "$STAGE/$hash.gz" && ! -L "$STAGE/$hash.gz" ]] || return 1
  /usr/bin/sqlite3 -json "$LEDGER" "SELECT * FROM uploads WHERE raw_hash=$(sql_quote "$hash");" > "$rowfile"
  uploadid=$(json_value "$rowfile" 0.upload_id || true)
  # Always reconcile a possibly successful upload before obtaining a new policy.
  if [[ $uploadid == [0-9a-f-]## && ${#uploadid} == 36 ]]; then
    if http POST "/api/device/v1/uploads/$uploadid/complete" '{}'; then confirm_row "$hash" "$HTTP_RESPONSE" && return 0; fi
  fi
  json_new "$f"; json_int "$f" schemaVersion 1; json_string "$f" collectionId "$(json_value "$rowfile" 0.collection_id)"
  r=$(json_value "$rowfile" 0.request_id || true); [[ -z $r ]] || json_string "$f" requestId "$r"
  json_string "$f" rawSha256 "$hash"; json_string "$f" gzipSha256 "$(json_value "$rowfile" 0.gzip_hash)"; json_int "$f" rawBytes "$(json_value "$rowfile" 0.raw_bytes)"; json_int "$f" gzipBytes "$(json_value "$rowfile" 0.gzip_bytes)"
  /usr/bin/plutil -insert source -json "$(json_value "$rowfile" 0.source_json)" "$f"; /usr/bin/plutil -insert metadata -json "$(json_value "$rowfile" 0.metadata_json)" "$f"
  if ! http POST /api/device/v1/uploads/prepare "$(as_json "$f")"; then retry_row "$hash" "http_$HTTP_CODE"; return 1; fi
  state=$(json_value "$HTTP_RESPONSE" state)
  if [[ $state == already_present ]]; then confirm_row "$hash" "$HTTP_RESPONSE"; return; fi
  [[ $state == reserved ]] || return 1
  /bin/cp "$HTTP_RESPONSE" "$WORK/policy.json"; uploadid=$(json_value "$WORK/policy.json" uploadId)
  [[ $uploadid == [0-9a-f-]## && ${#uploadid} == 36 ]] || return 1
  ledger_sql "UPDATE uploads SET state='authorized',upload_id=$(sql_quote "$uploadid") WHERE raw_hash=$(sql_quote "$hash");" || return 1
  has_budget || return 1
  if ! post_gcs "$WORK/policy.json" "$STAGE/$hash.gz"; then
    # Existing immutable objects may reject a repeated POST. Completion decides.
    if http POST "/api/device/v1/uploads/$uploadid/complete" '{}'; then confirm_row "$hash" "$HTTP_RESPONSE"; return; fi
    retry_row "$hash" "upload_$HTTP_CODE"; return 1
  fi
  ledger_sql "UPDATE uploads SET state='uploaded_unconfirmed' WHERE raw_hash=$(sql_quote "$hash");" || return 1
  if http POST "/api/device/v1/uploads/$uploadid/complete" '{}'; then confirm_row "$hash" "$HTTP_RESPONSE"; else retry_row "$hash" "complete_$HTTP_CODE"; return 1; fi
}
retry_staged() {
  local hash bytes
  for hash in ${(@f)$(ledger_sql "SELECT raw_hash FROM uploads WHERE state IN ('staged','authorized','uploaded_unconfirmed','retry_wait') AND retry_at <= $(/bin/date +%s) ORDER BY created_at LIMIT 100;")}; do
    has_budget || return 1
    bytes=$(ledger_sql "SELECT gzip_bytes FROM uploads WHERE raw_hash=$(sql_quote "$hash");"); (( RUN_BYTES + bytes <= 52428800 )) || break
    RUN_BYTES=$((RUN_BYTES+bytes)); if upload_one "$hash"; then CONFIRMED=$((CONFIRMED+1)); else FAILED=$((FAILED+1)); fi
  done
}
snapshot() {
  local user=$1 user_home=$2 uid=$3 name=$4 min=$5 max=$6 source_key source_stat raw="$STAGE/$$.raw" size hash gz ghash source="$WORK/source.json" mtime used free known_state
  source_key="$uid:$name"; source_stat=$(/usr/bin/stat -f '%d:%i:%z:%m' "$user_home/Library/Logs/Safe Exam Browser/$name" 2>/dev/null) || return 1
  # Explicit requests rehash; routine stat-cache hits remain a performance hint.
  if [[ $COLLECTION_REASON != on_demand && -n $(ledger_sql "SELECT raw_hash FROM uploads WHERE state='confirmed' AND source_key=$(sql_quote "$source_key") AND source_stat=$(sql_quote "$source_stat") LIMIT 1;") ]]; then SKIPPED=$((SKIPPED+1)); return 0; fi
  size=$(/usr/bin/stat -f '%z' "$user_home/Library/Logs/Safe Exam Browser/$name"); (( size>0 && size<=MAX_RAW )) || { SKIPPED=$((SKIPPED+1)); return 1; }
  used=$(/usr/bin/du -sk "$STAGE" | /usr/bin/awk '{print $1*1024}'); free=$(/bin/df -k "$STAGE" | /usr/bin/awk 'NR==2 {print $4*1024}')
  (( used+size+MAX_GZIP<=MAX_STAGE && free-size-MAX_GZIP >= 1073741824 )) || { set_outcome disk_pressure; return 1; }
  if ! reader "$user" read "$user_home" "$uid" "$min" "$max" "$name" > "$raw"; then /bin/rm -f "$raw"; return 1; fi
  [[ $(/usr/bin/stat -f '%z' "$raw") == $size ]] || { /bin/rm -f "$raw"; return 1; }
  hash=$(hash_file "$raw") || { /bin/rm -f "$raw"; return 1; }
  known_state=$(ledger_sql "SELECT state FROM uploads WHERE raw_hash=$(sql_quote "$hash");") || { /bin/rm -f "$raw"; return 1; }
  if [[ $known_state == confirmed ]]; then /bin/rm -f "$raw"; SKIPPED=$((SKIPPED+1)); return 0; fi
  if [[ -f "$STAGE/$hash.gz" && -n $known_state ]]; then /bin/rm -f "$raw"; return 0; fi
  # Rebuild an untracked payload from the verified snapshot, then attach a row.
  /usr/bin/gzip -1 -n -c "$raw" > "$STAGE/$hash.gz.tmp" || { /bin/rm -f "$raw" "$STAGE/$hash.gz.tmp"; return 1; }; /bin/rm -f "$raw"
  gz=$(/usr/bin/stat -f '%z' "$STAGE/$hash.gz.tmp"); (( gz<=MAX_GZIP )) || { /bin/rm -f "$STAGE/$hash.gz.tmp"; return 1; }; /bin/mv "$STAGE/$hash.gz.tmp" "$STAGE/$hash.gz"
  ghash=$(hash_file "$STAGE/$hash.gz"); mtime=$(/usr/bin/stat -f '%m' "$user_home/Library/Logs/Safe Exam Browser/$name")
  json_new "$source"; json_string "$source" username "$user"; json_int "$source" uid "$uid"; json_string "$source" relativePath "Library/Logs/Safe Exam Browser/$name"; json_string "$source" basename "$name"; json_int "$source" bytes "$size"; json_string "$source" mtime "$(/bin/date -u -r "$mtime" '+%Y-%m-%dT%H:%M:%SZ')"
  ledger_sql "INSERT INTO uploads(raw_hash,gzip_hash,raw_bytes,gzip_bytes,source_json,metadata_json,collection_id,request_id,state,created_at,source_key,source_stat) VALUES($(sql_quote "$hash"),$(sql_quote "$ghash"),$size,$gz,$(sql_quote "$(as_json "$source")"),$(sql_quote "$(as_json "$METADATA")"),$(sql_quote "$COLLECTION_ID"),$(sql_quote "$REQUEST_ID"),'staged',$(/bin/date +%s),$(sql_quote "$source_key"),$(sql_quote "$source_stat")) ON CONFLICT(raw_hash) DO UPDATE SET state='staged',gzip_hash=excluded.gzip_hash,gzip_bytes=excluded.gzip_bytes,collection_id=excluded.collection_id,request_id=excluded.request_id;"
}
scan() {
  local minimum=$1 maximum=$2 user uid user_home name list="$WORK/files" lines directories=0 unreadable=0
  /usr/bin/dscl . -list /Users UniqueID > "$WORK/users"
  while read -r user uid; do
    [[ $uid == <-> && $uid -ge 501 && $user != Guest && $user != Shared && $user != _* && $user == [a-zA-Z0-9_-]## ]] || continue
    has_budget || return 1
    user_home=$(/usr/bin/dscl . -read "/Users/$user" NFSHomeDirectory | /usr/bin/sed 's/^NFSHomeDirectory: //')
    [[ $user_home == /Users/* && ! -L $user_home ]] || continue
    local include='' exclude=''
    include=$(/usr/bin/plutil -extract includeUsers json -o - "$CONFIG" 2>/dev/null || true); exclude=$(/usr/bin/plutil -extract excludeUsers json -o - "$CONFIG" 2>/dev/null || true)
    [[ -z $include || $include == '[]' || $include == *"\"$user\""* ]] || continue
    [[ -z $exclude || $exclude != *"\"$user\""* ]] || continue
    if [[ ! -d "$user_home/Library/Logs/Safe Exam Browser" ]]; then continue; fi
    directories=$((directories+1))
    if ! reader "$user" list "$user_home" "$uid" "$minimum" "$maximum" > "$list"; then unreadable=$((unreadable+1)); continue; fi
    while IFS= read -r name; do
      has_budget || return 1
      FOUND=$((FOUND+1)); snapshot "$user" "$user_home" "$uid" "$name" "$minimum" "$maximum" || FAILED=$((FAILED+1))
    done < "$list"
  done < "$WORK/users"
  if (( directories==0 )); then SCAN_OUTCOME=directory_missing; elif (( unreadable>0 && FOUND==0 )); then SCAN_OUTCOME=unreadable; elif (( FOUND>0 )); then SCAN_OUTCOME=completed; fi
}
tick() {
  local reason=$1 configfile="$WORK/config.json" due today minute daily='' request n minimum maximum
  [[ ! -f "$STATE/stopping" ]] || return 0
  [[ ! -f "$STATE/paused" ]] || { set_outcome paused; return 0; }
  if [[ ! -f $CREDS || ! -n $(json_value "$CREDS" deviceId || true) ]]; then
    if [[ -f "$STATE/enrollment-bootstrap" ]]; then retry_enrollment || return 0
    else set_outcome unenrolled; return 0; fi
  fi
  [[ ! -L $CREDS ]] || return 1
  if seb_running; then set_outcome deferred; return 0; fi
  if ! http GET /api/device/v1/config; then [[ $HTTP_CODE == 401 || $HTTP_CODE == 403 ]] && set_outcome blocked || set_outcome offline; return 0; fi
  /bin/cp "$HTTP_RESPONSE" "$configfile"; print -r -- "$(utc)" > "$STATE/last-contact"
  flush_reports || true
  [[ $(json_value "$configfile" paused) != true ]] || { set_outcome paused; return 0; }
  stage_cleanup
  retry_staged || true
  due=$(setting due_minute); if [[ -z $due ]]; then due=$((930+RANDOM%241)); save_setting due_minute "$due"; fi
  today=$(/bin/date '+%Y-%m-%d'); minute=$((10#$(/bin/date +%H)*60+10#$(/bin/date +%M)))
  if [[ $(setting initial_pending) == 1 ]]; then daily=initial; elif [[ $reason == on_demand ]]; then daily=on_demand; elif [[ $(setting last_daily) != $today && $minute -ge $due ]]; then daily=daily; fi
  n=0
  while request=$(json_value "$configfile" "requests.$n.id" 2>/dev/null); do
    has_budget || break
    REQUEST_ID=$request; minimum=$(/bin/date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$(json_value "$configfile" "requests.$n.from" | /usr/bin/sed -E 's/\.[0-9]+Z$/Z/')" '+%s'); maximum=$(/bin/date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$(json_value "$configfile" "requests.$n.to" | /usr/bin/sed -E 's/\.[0-9]+Z$/Z/')" '+%s')
    run_collection on_demand "$minimum" "$maximum" || true
    n=$((n+1))
  done
  if [[ -n $daily ]] && has_budget; then REQUEST_ID=''; local days=90; [[ $daily != initial ]] || days=7; minimum=$(( $(/bin/date +%s) - days*86400 )); run_collection "$daily" "$minimum" "$(/bin/date +%s)" && { save_setting last_daily "$today"; save_setting initial_pending 0; }; fi
  [[ -n $daily || $n -gt 0 ]] || set_outcome idle
}
run_collection() {
  typeset -g COLLECTION_REASON=$1 COLLECTION_STARTED=$(utc)
  local min=$2 max=$3
  local reports=("$STATE/reports"/*.json(N))
  (( ${#reports} < 100 )) || { set_outcome report_backlog; return 1; }
  COLLECTION_ID=''
  if [[ -n $REQUEST_ID ]]; then COLLECTION_ID=$(setting "request_$REQUEST_ID"); COLLECTION_ID=${COLLECTION_ID%%:*}; fi
  if [[ -z $COLLECTION_ID ]]; then
    COLLECTION_ID=$(/usr/bin/uuidgen); COLLECTION_ID=${COLLECTION_ID:l}
    [[ -z $REQUEST_ID ]] || save_setting "request_$REQUEST_ID" "$COLLECTION_ID:$(/bin/date +%s)"
  fi
  FOUND=0; CONFIRMED=0; FAILED=0; SKIPPED=0; SCAN_OUTCOME=no_logs
  /bin/rm -f "$STATE/last-error"
  METADATA="$WORK/metadata.json"; metadata "$METADATA"
  collection_report running || return 1
  ack_request running || return 1
  scan "$min" "$max" || SCAN_OUTCOME=deferred
  retry_staged || SCAN_OUTCOME=deferred
  (( FAILED == 0 )) || SCAN_OUTCOME=failed
  collection_report "$SCAN_OUTCOME" || return 1
  set_outcome "$SCAN_OUTCOME"
  [[ $SCAN_OUTCOME != deferred && $SCAN_OUTCOME != failed ]]
}
SOE_FILE_e49e67248534477ebea47aca
[[ $(/usr/bin/shasum -a 256 < "$incoming/bin/lib/collection.zsh" | /usr/bin/awk '{print $1}') == 'e49e67248534477ebea47aca5d36432d8941d250fa8ddf6b280fbe312b8ef236' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/bin/lib/collection.zsh"

# bin/lib/common.zsh
/bin/cat > "$incoming/bin/lib/common.zsh" <<'SOE_FILE_525c4a2df77aabe29e2bfc4c'
typeset WORK='' LOCK_TOKEN='' CURRENT_CHILD='' API_ORIGIN='' HTTP_RESPONSE='' HTTP_CODE='' COLLECTOR_START=$SECONDS
typeset -r MAX_RAW=67108864 MAX_GZIP=20971520 MAX_STAGE=262144000 MAX_RUN=300
tool_check() {
  local t
  for t in /usr/bin/curl /usr/bin/plutil /usr/bin/sqlite3 /usr/bin/shasum /usr/bin/gzip /usr/bin/openssl /usr/bin/uuidgen /usr/bin/stat /usr/bin/sudo /usr/bin/dscl /usr/bin/sw_vers /usr/sbin/ioreg /usr/bin/pgrep /usr/bin/pmset; do [[ -x $t ]] || die missing_tool; done
  [[ -f $CONFIG && ! -L $CONFIG ]] || die config_missing
  API_ORIGIN=$(/usr/bin/plutil -extract apiOrigin raw -o - "$CONFIG") || die invalid_config
  [[ $API_ORIGIN == https://* && $API_ORIGIN != *[$'\n\r\t "\\']* && ${API_ORIGIN#https://} != */* && ${API_ORIGIN#https://} != *'@'* && ${API_ORIGIN#https://} != *'?'* && ${API_ORIGIN#https://} != *'#'* ]] || die invalid_api_origin
}
utc() { /bin/date -u '+%Y-%m-%dT%H:%M:%SZ'; }
hash_file() { /usr/bin/shasum -a 256 < "$1" | /usr/bin/awk '{print $1}'; }
json_new() { print -r -- '{"_soe_init":true}' > "$1"; }
json_string() { /usr/bin/plutil -insert "$2" -string "$3" "$1"; /usr/bin/plutil -remove _soe_init "$1" 2>/dev/null || true; }
json_int() { /usr/bin/plutil -insert "$2" -integer "$3" "$1"; /usr/bin/plutil -remove _soe_init "$1" 2>/dev/null || true; }
json_value() { /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null; }
json_object() { /usr/bin/plutil -insert "$2" -json "$(/bin/cat "$3")" "$1"; }
as_json() { /usr/bin/plutil -convert json -o - "$1"; }
sql_quote() { local s=$1 apostrophe="'"; print -rn -- "'${s//$apostrophe/$apostrophe$apostrophe}'"; }
atomic_json() { /usr/bin/plutil -convert json "$1" && /bin/chmod 600 "$1" && /bin/mv -f "$1" "$2"; }
set_outcome() { print -r -- "$1" > "$STATE/outcome.tmp"; /bin/mv -f "$STATE/outcome.tmp" "$STATE/outcome"; }
set_error() { print -r -- "$1" > "$STATE/last-error.tmp"; /bin/mv -f "$STATE/last-error.tmp" "$STATE/last-error"; }
rotate_logs() {
  local dir='/Library/Logs/SOEDiagnostics' file old
  [[ ${SOE_TEST_MODE:-0} != 1 ]] || dir="$ROOT/logs"
  [[ -d $dir && ! -L $dir ]] || return 0
  file="$dir/collector.log"
  [[ ! -L $file ]] || die unsafe_log_path
  /usr/bin/find "$dir" -type f -name 'collector.*.log' -mtime +7 -delete
  if [[ -f $file ]] && (( $(/usr/bin/stat -f '%z' "$file") >= 2097152 )); then
    for old in 3 2 1; do
      [[ ! -L "$dir/collector.$old.log" ]] || die unsafe_log_path
    done
    /bin/rm -f "$dir/collector.3.log"
    [[ ! -f "$dir/collector.2.log" ]] || /bin/mv "$dir/collector.2.log" "$dir/collector.3.log"
    [[ ! -f "$dir/collector.1.log" ]] || /bin/mv "$dir/collector.1.log" "$dir/collector.2.log"
    /usr/bin/tail -c 2097152 "$file" > "$dir/collector.1.log"
    # Truncate the active inode: launchd has stdout/stderr open on it already.
    : > "$file"
  fi
}
die() { set_outcome "$1" 2>/dev/null || true; print -u2 -- "Safe Online Exam Logs: $1"; exit 1; }
acquire_lock() {
  local lock="$STATE/lock" pid boot current_boot
  current_boot=$(/usr/sbin/sysctl -n kern.boottime)
  if ! /bin/mkdir "$lock" 2>/dev/null; then
    [[ ! -L $lock && -f "$lock/pid" && ! -L "$lock/pid" ]] || return 1
    pid=$(<"$lock/pid"); boot=$(<"$lock/boot")
    [[ $pid == <-> ]] || return 1
    if [[ $boot == $current_boot ]] && /bin/kill -0 "$pid" 2>/dev/null; then return 1; fi
    /bin/mv "$lock" "$STATE/lock.stale.$$" 2>/dev/null || return 1
    /bin/rm -rf "$STATE/lock.stale.$$"
    /bin/mkdir "$lock" 2>/dev/null || return 1
  fi
  LOCK_TOKEN=$(/usr/bin/uuidgen)
  print -r -- $$ > "$lock/pid"; print -r -- "$current_boot" > "$lock/boot"; print -r -- "$LOCK_TOKEN" > "$lock/token"
  WORK=$(/usr/bin/mktemp -d "$STATE/work.XXXXXXXX")
}
cleanup() {
  [[ -z $CURRENT_CHILD ]] || stop_child "$CURRENT_CHILD"
  [[ -z $WORK || ! -d $WORK ]] || /bin/rm -rf "$WORK"
  if [[ -n $LOCK_TOKEN && -f "$STATE/lock/token" && $(<"$STATE/lock/token") == $LOCK_TOKEN ]]; then /bin/rm -rf "$STATE/lock"; fi
}
stop_child() {
  local pid=$1 p args
  [[ $pid == <-> ]] || return
  for p in ${(@f)$(/usr/bin/pgrep -P "$pid" 2>/dev/null || true)}; do stop_child "$p"; done
  args=$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)
  [[ $args == *SOEDiagnostics* || $args == *read-source* || $args == *collector-test* || $args == */bin/dd* || $args == */usr/bin/stat* ]] && /bin/kill -TERM "$pid" 2>/dev/null || true
}
reader() {
  local user=$1; shift
  /usr/bin/sudo -n -u "$user" -- /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/zsh -f "$BIN/read-source" "$@" &
  local pid=$! start=$SECONDS
  CURRENT_CHILD=$pid; print -r -- "$pid" > "$STATE/reader.pid"
  while /bin/kill -0 "$pid" 2>/dev/null; do
    if (( SECONDS-start > 30 || SECONDS-COLLECTOR_START > MAX_RUN )); then stop_child "$pid"; wait "$pid" 2>/dev/null || true; CURRENT_CHILD=''; return 1; fi
    /bin/sleep 0.1
  done
  local result=0; wait "$pid" || result=$?; CURRENT_CHILD=''; /bin/rm -f "$STATE/reader.pid"; return $result
}
seb_running() { /usr/bin/pgrep -x 'Safe Exam Browser' >/dev/null 2>&1 || /usr/bin/pgrep -x SafeExamBrowser >/dev/null 2>&1; }
status_json() {
  local f=$(/usr/bin/mktemp "$STATE/status.XXXXXXXX")
  json_new "$f"; json_string "$f" collectorVersion "$VERSION"
  json_string "$f" outcome "$([[ -f "$STATE/outcome" ]] && /bin/cat "$STATE/outcome" || print unenrolled)"
  /usr/bin/plutil -insert enrolled -bool "$([[ -f $CREDS && -n $(json_value "$CREDS" deviceId || true) ]] && print YES || print NO)" "$f"
  /usr/bin/plutil -insert locallyPaused -bool "$([[ -f "$STATE/paused" ]] && print YES || print NO)" "$f"
  [[ ! -f "$STATE/last-contact" ]] || json_string "$f" lastContact "$(<"$STATE/last-contact")"
  [[ ! -f "$STATE/last-error" ]] || json_string "$f" lastError "$(<"$STATE/last-error")"
  as_json "$f"; /bin/rm -f "$f"
}
SOE_FILE_525c4a2df77aabe29e2bfc4c
[[ $(/usr/bin/shasum -a 256 < "$incoming/bin/lib/common.zsh" | /usr/bin/awk '{print $1}') == '525c4a2df77aabe29e2bfc4cfb7021df66485d77b5e5b73e78ab65ab98f1825e' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/bin/lib/common.zsh"

# bin/lib/enrollment.zsh
/bin/cat > "$incoming/bin/lib/enrollment.zsh" <<'SOE_FILE_ac7301d62955b99dbebac54b'
enroll() {
  local bootstrap installation encoded f="$WORK/device.tmp" b="$WORK/enroll.json" digest serial
  bootstrap=$(/bin/cat); [[ $bootstrap == [A-Za-z0-9_-]## && ${#bootstrap} == 43 ]] || die invalid_bootstrap
  [[ ! -L "$STATE/enrollment-bootstrap" ]] || die unsafe_bootstrap_path
  if [[ ! -f "$STATE/enrollment-bootstrap" || $(<"$STATE/enrollment-bootstrap") != $bootstrap ]]; then
    print -rn -- "$bootstrap" > "$WORK/bootstrap.tmp"
    /bin/chmod 600 "$WORK/bootstrap.tmp"; /bin/mv -f "$WORK/bootstrap.tmp" "$STATE/enrollment-bootstrap"
  fi
  if [[ ! -f $CREDS ]]; then
    /usr/bin/openssl rand 32 > "$WORK/secret.bin" || die random_failed
    encoded=$(/usr/bin/openssl base64 -A -in "$WORK/secret.bin" | /usr/bin/tr '+/' '-_' | /usr/bin/tr -d '=')
    digest=$(hash_file "$WORK/secret.bin"); installation=$(/usr/bin/uuidgen); installation=${installation:l}
    print -r -- "{\"installationId\":\"$installation\",\"secret\":\"$encoded\",\"credentialHash\":\"$digest\"}" > "$f"
    atomic_json "$f" "$CREDS"
  fi
  # Reconcile a committed enrollment even if its bootstrap has since expired.
  if http GET /api/device/v1/config; then
    /bin/cp "$CREDS" "$f"; /usr/bin/plutil -replace deviceId -string "$(json_value "$HTTP_RESPONSE" deviceId)" "$f" 2>/dev/null || json_string "$f" deviceId "$(json_value "$HTTP_RESPONSE" deviceId)"; atomic_json "$f" "$CREDS"; /bin/rm -f "$STATE/enrollment-bootstrap"; set_outcome enrolled; return 0
  fi
  serial=$(/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice | /usr/bin/awk -F '"' '/IOPlatformSerialNumber/{print $(NF-1)}')
  [[ $serial == [A-Za-z0-9-]## ]] || die serial_unavailable
  metadata "$WORK/metadata.json"; json_new "$b"; json_int "$b" schemaVersion 1; json_string "$b" installationId "$(json_value "$CREDS" installationId)"; json_string "$b" credentialHash "$(json_value "$CREDS" credentialHash)"; json_string "$b" serial "$serial"; json_object "$b" metadata "$WORK/metadata.json"; /usr/bin/plutil -convert json "$b"
  if ! bootstrap_http "$bootstrap" "$b"; then set_outcome enrollment_pending; return 1; fi
  /bin/cp "$CREDS" "$f"; json_string "$f" deviceId "$(json_value "$HTTP_RESPONSE" deviceId)"; atomic_json "$f" "$CREDS"
  save_setting initial_pending 1; set_outcome enrolled
  /bin/rm -f "$STATE/enrollment-bootstrap"
  print 'Enrollment complete'
}
retry_enrollment() {
  local pending="$STATE/enrollment-bootstrap" created
  [[ -f $pending && ! -L $pending ]] || return 1
  created=$(/usr/bin/stat -f '%m' "$pending") || return 1
  if (( $(/bin/date +%s)-created > 604800 )); then /bin/rm -f "$pending"; set_outcome bootstrap_expired; return 1; fi
  enroll < "$pending"
}
SOE_FILE_ac7301d62955b99dbebac54b
[[ $(/usr/bin/shasum -a 256 < "$incoming/bin/lib/enrollment.zsh" | /usr/bin/awk '{print $1}') == 'ac7301d62955b99dbebac54be2b1dc711479d288f89b4c6b280dedac7d1b605b' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/bin/lib/enrollment.zsh"

# bin/lib/http.zsh
/bin/cat > "$incoming/bin/lib/http.zsh" <<'SOE_FILE_7afdf7c77a379b17f4739ffb'
curl_value() { local s=$1; [[ $s != *[$'\n\r\t']* ]] || return 1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; print -rn -- "$s"; }
curl_option() { print -r -- "$2 = \"$(curl_value "$3")\"" >> "$1"; }
http() {
  local method=$1 route=$2 body=${3:-} max=${4:-45} token cfg="$WORK/http.curl" out="$WORK/response.json" bodyfile="$WORK/body.json"
  local remaining=$((MAX_RUN-SECONDS+COLLECTOR_START))
  (( remaining > 0 )) || return 1
  (( max <= remaining )) || max=$remaining
  [[ $route == /api/device/v1/* && $route != *[$'\n\r "\\']* ]] || return 1
  token="$(json_value "$CREDS" installationId).$(json_value "$CREDS" secret)"
  [[ $token == [0-9a-f-]##.[A-Za-z0-9_-]## ]] || return 1
  : > "$cfg"; curl_option "$cfg" url "$API_ORIGIN$route"; curl_option "$cfg" header "Authorization: Bearer $token"; curl_option "$cfg" header 'Content-Type: application/json'; curl_option "$cfg" request "$method"; curl_option "$cfg" output "$out"
  if [[ -n $body ]]; then print -rn -- "$body" > "$bodyfile"; curl_option "$cfg" data-binary "@$bodyfile"; fi
  HTTP_CODE=$(/usr/bin/curl -q --config "$cfg" --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time "$max" --max-filesize 262144 --write-out '%{http_code}' 2>/dev/null) || { HTTP_CODE=000; return 1; }
  HTTP_RESPONSE=$out
  [[ $HTTP_CODE == 2<-> ]] || return 1
  [[ $method == POST && $route == */deactivate ]] && return 0
  /usr/bin/plutil -convert json -o /dev/null "$out" >/dev/null 2>&1 || return 1
}
bootstrap_http() {
  local bootstrap=$1 cfg="$WORK/bootstrap.curl" bodyfile=$2 out="$WORK/enrollment-response.json"
  local max=$((MAX_RUN-SECONDS+COLLECTOR_START))
  (( max > 0 )) || return 1
  (( max <= 45 )) || max=45
  : > "$cfg"; curl_option "$cfg" url "$API_ORIGIN/api/device/v1/enroll"; curl_option "$cfg" header "Authorization: Bearer $bootstrap"; curl_option "$cfg" header 'Content-Type: application/json'; curl_option "$cfg" request POST; curl_option "$cfg" data-binary "@$bodyfile"; curl_option "$cfg" output "$out"
  HTTP_CODE=$(/usr/bin/curl -q --config "$cfg" --silent --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time "$max" --max-filesize 262144 --write-out '%{http_code}' 2>/dev/null) || return 1
  HTTP_RESPONSE=$out; [[ $HTTP_CODE == 2<-> ]] && /usr/bin/plutil -convert json -o /dev/null "$out" >/dev/null
}
post_gcs() {
  local policy=$1 gzipfile=$2 cfg="$WORK/gcs.curl" url key value field count
  local max=$((MAX_RUN-SECONDS+COLLECTOR_START))
  (( max > 0 )) || return 1
  (( max <= 90 )) || max=90
  url=$(json_value "$policy" url)
  [[ $url == https://storage.googleapis.com/[a-z0-9._-]## && $gzipfile == "$STAGE/"[a-f0-9]##.gz && -f $gzipfile && ! -L $gzipfile ]] || return 1
  : > "$cfg"; curl_option "$cfg" url "$url"; curl_option "$cfg" output "$WORK/gcs-response"
  # Fixed approved keys; form-string keeps every value literal, even leading @.
  for key in key Content-Type success_action_status x-goog-algorithm x-goog-credential x-goog-date x-goog-meta-upload-id policy x-goog-signature; do
    value=$(json_value "$policy" "fields.$key") || return 1
    curl_option "$cfg" form-string "$key=$value"
  done
  curl_option "$cfg" form "file=@$gzipfile;type=application/gzip"
  HTTP_CODE=$(/usr/bin/curl -q --config "$cfg" --silent --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time "$max" --write-out '%{http_code}' 2>/dev/null) || return 1
  [[ $HTTP_CODE == 2<-> ]]
}
SOE_FILE_7afdf7c77a379b17f4739ffb
[[ $(/usr/bin/shasum -a 256 < "$incoming/bin/lib/http.zsh" | /usr/bin/awk '{print $1}') == '7afdf7c77a379b17f4739ffb338738bec2871a7e42097abcb2473b68f4c24b88' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/bin/lib/http.zsh"

# bin/lib/ledger.zsh
/bin/cat > "$incoming/bin/lib/ledger.zsh" <<'SOE_FILE_d7b99b2a8f1ff7f8d00cf8f1'
typeset -r LEDGER="$STATE/ledger.sqlite"
ledger_sql() {
  local code=0
  # SQLite parser errors may echo SQL containing source-user/device metadata.
  /usr/bin/sqlite3 -batch -bail "$LEDGER" "$1" 2>/dev/null || code=$?
  if (( code != 0 )); then set_error ledger_error; print -u2 "Safe Online Exam Logs: ledger operation failed (SQLite exit $code)"; fi
  return $code
}
ledger_init() {
  [[ ! -L $LEDGER ]] || die ledger_symlink
  ledger_sql 'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS uploads(raw_hash TEXT PRIMARY KEY,gzip_hash TEXT,raw_bytes INTEGER,gzip_bytes INTEGER,source_json TEXT,metadata_json TEXT,collection_id TEXT,request_id TEXT,upload_id TEXT,state TEXT NOT NULL,attempts INTEGER DEFAULT 0,retry_at INTEGER DEFAULT 0,last_error TEXT,ack_json TEXT,created_at INTEGER,source_key TEXT,source_stat TEXT); PRAGMA user_version=1;' >/dev/null
  /bin/chmod 600 "$LEDGER"
}
setting() { ledger_sql "SELECT value FROM settings WHERE key=$(sql_quote "$1");"; }
save_setting() { ledger_sql "INSERT INTO settings(key,value) VALUES($(sql_quote "$1"),$(sql_quote "$2")) ON CONFLICT(key) DO UPDATE SET value=excluded.value;"; }
retry_row() {
  local hash=$1 error=$2 attempts next delay
  attempts=$(ledger_sql "SELECT attempts+1 FROM uploads WHERE raw_hash=$(sql_quote "$hash");")
  delay=$(( 60 * 2 ** (attempts > 9 ? 9 : attempts) + RANDOM % 300 )); next=$(( $(/bin/date +%s) + delay ))
  ledger_sql "UPDATE uploads SET state='retry_wait',attempts=$attempts,retry_at=$next,last_error=$(sql_quote "$error") WHERE raw_hash=$(sql_quote "$hash");"
}
confirm_row() {
  local hash=$1 ack=$2 returned
  returned=$(json_value "$ack" acknowledgment.rawSha256) || return 1
  [[ $returned == $hash ]] || return 1
  ledger_sql "UPDATE uploads SET state='confirmed',ack_json=$(sql_quote "$(as_json "$ack")"),last_error=NULL WHERE raw_hash=$(sql_quote "$hash");" || return 1
  /bin/rm -f "$STAGE/$hash.gz"
}
SOE_FILE_d7b99b2a8f1ff7f8d00cf8f1
[[ $(/usr/bin/shasum -a 256 < "$incoming/bin/lib/ledger.zsh" | /usr/bin/awk '{print $1}') == 'd7b99b2a8f1ff7f8d00cf8f1e7b61fdda107d5fcf904a3ddcff1415f858afa24' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/bin/lib/ledger.zsh"

# bin/lib/metadata.zsh
/bin/cat > "$incoming/bin/lib/metadata.zsh" <<'SOE_FILE_ca63ee0a5e82b61289873f14'
metadata() {
  local f=$1 p sebv='' sebb='' console
  json_new "$f"; json_string "$f" collectorVersion "$VERSION"; json_string "$f" architecture "$(/usr/bin/uname -m)"; json_string "$f" macOSVersion "$(/usr/bin/sw_vers -productVersion)"; json_string "$f" macOSBuild "$(/usr/bin/sw_vers -buildVersion)"; json_string "$f" reportedAt "$(utc)"
  json_string "$f" timezone "$(/usr/bin/readlink /etc/localtime | /usr/bin/sed 's|.*/zoneinfo/||')"
  p='/Applications/Safe Exam Browser.app/Contents/Info.plist'
  if [[ -f $p ]]; then sebv=$(json_value "$p" CFBundleShortVersionString); sebb=$(json_value "$p" CFBundleVersion); json_string "$f" sebVersion "$sebv"; json_string "$f" sebBuild "$sebb"; json_string "$f" sebPath '/Applications/Safe Exam Browser.app'; else /usr/bin/plutil -insert sebVersion -json null "$f"; fi
  console=$(/usr/bin/stat -f '%Su' /dev/console); json_string "$f" consoleUser "$console"
  for p in HostName LocalHostName ComputerName; do local k="${p[1,1]:l}${p[2,-1]}"; json_string "$f" "$k" "$(/usr/sbin/scutil --get "$p" 2>/dev/null || true)"; done
  /usr/bin/plutil -convert json "$f"
}
SOE_FILE_ca63ee0a5e82b61289873f14
[[ $(/usr/bin/shasum -a 256 < "$incoming/bin/lib/metadata.zsh" | /usr/bin/awk '{print $1}') == 'ca63ee0a5e82b61289873f140da84f309803f3e2c9b3a39c9c069ad3f0d2aefd' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/bin/lib/metadata.zsh"

# support/manage.zsh
/bin/cat > "$incoming/support/manage.zsh" <<'SOE_FILE_99803e129c9c5e50ae0ae0e4'
#!/bin/zsh -f
# Root-only maintenance dispatcher. Launchers use sudo; Jamf already runs as root.
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL EXTENDED_GLOB
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset CDPATH ENV BASH_ENV
typeset -r ROOT='/Library/Application Support/SOEDiagnostics'
[[ $EUID == 0 ]] || { print -u2 'Root required'; exit 1; }
for owned in "$ROOT" "$ROOT/support" "$ROOT/config.json" "$ROOT/state"; do
  [[ -e $owned && ! -L $owned ]] || { print -u2 'Installation missing or unsafe'; exit 1; }
done
check_script() {
  local file=$1 checksum=$2
  [[ -f $file && ! -L $file && -f $checksum && ! -L $checksum ]] || return 1
  [[ $(/usr/bin/shasum -a 256 < "$file" | /usr/bin/awk '{print $1}') == $(<"$checksum") ]] || { print -u2 'Script checksum mismatch'; return 1; }
  /bin/zsh -n "$file"
}
case ${1:-status} in
  collect) /bin/zsh -f "$ROOT/bin/soe-diagnostics" collect --now; /bin/zsh -f "$ROOT/support/manage.zsh" status ;;
  pause|resume) /bin/zsh -f "$ROOT/bin/soe-diagnostics" "$1" ;;
  status)
    file=$(/usr/bin/mktemp "$ROOT/state/command-status.XXXXXXXX")
    trap '/bin/rm -f "$file"' EXIT
    /bin/zsh -f "$ROOT/bin/soe-diagnostics" status --json > "$file"
    print 'Safe Online Exam Logs'
    for field label in collectorVersion Version outcome Status enrolled Enrolled locallyPaused Paused lastContact 'Last contact' lastError 'Last error'; do
      value=$(/usr/bin/plutil -extract "$field" raw -o - "$file" 2>/dev/null || true)
      [[ -z $value ]] || print -r -- "$label: ${value//_/ }"
    done ;;
  reinstall|uninstall)
    action=$1; file="$ROOT/support/installer.zsh"; [[ $action != uninstall ]] || file="$ROOT/support/uninstall.zsh"
    check_script "$file" "$file.sha256"
    /bin/zsh -f "$file" ;;
  update)
    origin=$(/usr/bin/plutil -extract apiOrigin raw -o - "$ROOT/config.json")
    [[ $origin == https://* && $origin != *[$'\n\r\t "\\']* && ${origin#https://} != */* && ${origin#https://} != *[@?#]* ]] || { print -u2 'Invalid update origin'; exit 1; }
    work=$(/usr/bin/mktemp -d "$ROOT/state/update.XXXXXXXX")
    trap '/bin/rm -rf "$work"' EXIT
    /usr/bin/curl --fail --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 --max-filesize 262144 --output "$work/manifest.json" "$origin/collector/manifest.json"
    version=$(/usr/bin/plutil -extract version raw -o - "$work/manifest.json")
    expected=$(/usr/bin/plutil -extract installer.sha256 raw -o - "$work/manifest.json")
    installer_path=$(/usr/bin/plutil -extract installer.path raw -o - "$work/manifest.json")
    [[ $version == <->.<->.<-> && ${#version} -le 30 && $expected == [a-f0-9]## && ${#expected} == 64 && $installer_path == /collector/install.zsh ]] || { print -u2 'Invalid update manifest'; exit 1; }
    installed=$(<"$ROOT/state/installed-version")
    [[ $installed == <->.<->.<-> ]] || { print -u2 'Installed version is unavailable'; exit 1; }
    old=(${(s:.:)installed}); new=(${(s:.:)version}); newer=0
    for i in 1 2 3; do
      if (( 10#${new[$i]} > 10#${old[$i]} )); then newer=1; break
      elif (( 10#${new[$i]} < 10#${old[$i]} )); then print -u2 'Server release is older; refusing downgrade'; exit 1; fi
    done
    (( newer )) || { print -r -- "Already up to date ($installed)"; exit 0; }
    /usr/bin/curl --fail --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 90 --max-filesize 2097152 --output "$work/install.zsh" "$origin$installer_path"
    actual=$(/usr/bin/shasum -a 256 < "$work/install.zsh" | /usr/bin/awk '{print $1}')
    [[ $actual == $expected ]] || { print -u2 'Update checksum mismatch; existing installation preserved'; exit 1; }
    /bin/zsh -n "$work/install.zsh"
    print -r -- "Updating Safe Online Exam Logs from $installed to $version"
    /bin/zsh -f "$work/install.zsh" ;;
  *) print -u2 'Commands: collect, status, pause, resume, update, reinstall, uninstall'; exit 2 ;;
esac
SOE_FILE_99803e129c9c5e50ae0ae0e4
[[ $(/usr/bin/shasum -a 256 < "$incoming/support/manage.zsh" | /usr/bin/awk '{print $1}') == '99803e129c9c5e50ae0ae0e42070ee2088c116179783cabb90841bf8b04767d5' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/support/manage.zsh"

# support/uninstall.zsh
/bin/cat > "$incoming/support/uninstall.zsh" <<'SOE_FILE_5036384740d049bfef84fc9a'
#!/bin/zsh -f
# Shared lifecycle guard. Included in generated installer / uninstaller payloads.
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL EXTENDED_GLOB
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
typeset -r ROOT='/Library/Application Support/SOEDiagnostics' LABEL='org.soe.diagnostics.collector' PLIST='/Library/LaunchDaemons/org.soe.diagnostics.collector.plist' LOGS='/Library/Logs/SOEDiagnostics'
[[ $EUID == 0 ]] || { print -u2 'Root required'; exit 1; }
safe_path() {
  local input=$1 part current=''
  for part in ${(s:/:)input}; do [[ -z $part ]] || { current="$current/$part"; [[ ! -L $current ]] || { print -u2 'Unsafe symlink in owned path'; exit 1; }; }; done
}
for p in "$ROOT" "$PLIST" "$LOGS"; do safe_path "$p"; done
stop_job() {
  /bin/launchctl bootout "system/$LABEL" 2>/dev/null || true
  if /bin/launchctl print "system/$LABEL" >/dev/null 2>&1; then print -u2 'Collector job still loaded'; return 1; fi
  # Only processes executing our fixed project path are eligible for termination.
  local pid args seconds=0
  while (( seconds < 15 )); do
    local running=0
    for pid in ${(@f)$(/usr/bin/pgrep -f '/Library/Application Support/SOEDiagnostics/bin/(soe-diagnostics|read-source)' 2>/dev/null || true)}; do
      args=$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)
      if [[ $args == '/bin/zsh -f /Library/Application Support/SOEDiagnostics/bin/soe-diagnostics'* || $args == '/bin/zsh -f /Library/Application Support/SOEDiagnostics/bin/read-source'* ]]; then /bin/kill -TERM "$pid" 2>/dev/null || true; running=1; fi
    done
    (( running == 0 )) && return 0
    /bin/sleep 1; seconds=$((seconds+1))
  done
  print -u2 'Collector processes remain; removal stopped'; return 1
}

# Offline-safe: server revocation remains a separate IT action if unreachable.
if [[ -d $ROOT ]]; then
  for p in "$ROOT/bin" "$ROOT/credentials" "$ROOT/state" "$ROOT/staging"; do safe_path "$p"; done
  /bin/mkdir -p "$ROOT/state"; /usr/bin/touch "$ROOT/state/stopping"
  if [[ -f "$ROOT/bin/soe-diagnostics" ]]; then
    /bin/zsh -f "$ROOT/bin/soe-diagnostics" prepare-uninstall >/dev/null 2>&1 || true
  fi
fi
stop_job
for p in "$ROOT" "$PLIST" "$LOGS"; do safe_path "$p"; done
# Fixed project-owned locations only. No certificate, MDM, SEB, or user paths.
/bin/rm -rf "$ROOT" "$LOGS"
/bin/rm -f "$PLIST"
for p in "$ROOT" "$PLIST" "$LOGS"; do [[ ! -e $p && ! -L $p ]] || { print -u2 "Partial removal: $p remains"; exit 1; }; done
print 'Safe Online Exam Logs removed locally. Confirm server-side revocation in the dashboard.'
SOE_FILE_5036384740d049bfef84fc9a
[[ $(/usr/bin/shasum -a 256 < "$incoming/support/uninstall.zsh" | /usr/bin/awk '{print $1}') == '5036384740d049bfef84fc9a37381bb61c9e28d6b8a9fd7a94c45b1d23482056' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/support/uninstall.zsh"

# Collect Now.command
/bin/cat > "$incoming/Collect Now.command" <<'SOE_FILE_c3ff7e90f12640a6988493ca'
#!/bin/zsh -f
emulate -LR zsh
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
print 'Safe Online Exam Logs — Collect Now'
result=0
if (( EUID != 0 )); then
  /usr/bin/sudo -- /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' collect || result=$?
else
  /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' collect || result=$?
fi
if (( result != 0 )); then print -u2 'The command did not complete. Review the message above.'; fi
if [[ -t 0 && -t 1 ]]; then read -r '?Press Return to close this window.'; fi
exit $result
SOE_FILE_c3ff7e90f12640a6988493ca
[[ $(/usr/bin/shasum -a 256 < "$incoming/Collect Now.command" | /usr/bin/awk '{print $1}') == 'c3ff7e90f12640a6988493ca7b6cd4d2cdd37fed41491613bf3f2720987f83b0' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/Collect Now.command"

# Status.command
/bin/cat > "$incoming/Status.command" <<'SOE_FILE_f640ea15cc34665662c76709'
#!/bin/zsh -f
emulate -LR zsh
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
print 'Safe Online Exam Logs — Status'
result=0
if (( EUID != 0 )); then
  /usr/bin/sudo -- /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' status || result=$?
else
  /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' status || result=$?
fi
if (( result != 0 )); then print -u2 'The command did not complete. Review the message above.'; fi
if [[ -t 0 && -t 1 ]]; then read -r '?Press Return to close this window.'; fi
exit $result
SOE_FILE_f640ea15cc34665662c76709
[[ $(/usr/bin/shasum -a 256 < "$incoming/Status.command" | /usr/bin/awk '{print $1}') == 'f640ea15cc34665662c76709cbff076058fcf78b3422dfa47c1cd98f5a106d98' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/Status.command"

# Update.command
/bin/cat > "$incoming/Update.command" <<'SOE_FILE_8c5e06cf7099aebfbe82f19b'
#!/bin/zsh -f
emulate -LR zsh
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
print 'Safe Online Exam Logs — Update'
result=0
if (( EUID != 0 )); then
  /usr/bin/sudo -- /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' update || result=$?
else
  /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' update || result=$?
fi
if (( result != 0 )); then print -u2 'The command did not complete. Review the message above.'; fi
if [[ -t 0 && -t 1 ]]; then read -r '?Press Return to close this window.'; fi
exit $result
SOE_FILE_8c5e06cf7099aebfbe82f19b
[[ $(/usr/bin/shasum -a 256 < "$incoming/Update.command" | /usr/bin/awk '{print $1}') == '8c5e06cf7099aebfbe82f19b58c87ef06538a3dfc8a78124d96f67db7c490864' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/Update.command"

# Reinstall.command
/bin/cat > "$incoming/Reinstall.command" <<'SOE_FILE_a349052808c1317e682cbbb3'
#!/bin/zsh -f
emulate -LR zsh
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
print 'Safe Online Exam Logs — Reinstall'
result=0
if (( EUID != 0 )); then
  /usr/bin/sudo -- /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' reinstall || result=$?
else
  /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' reinstall || result=$?
fi
if (( result != 0 )); then print -u2 'The command did not complete. Review the message above.'; fi
if [[ -t 0 && -t 1 ]]; then read -r '?Press Return to close this window.'; fi
exit $result
SOE_FILE_a349052808c1317e682cbbb3
[[ $(/usr/bin/shasum -a 256 < "$incoming/Reinstall.command" | /usr/bin/awk '{print $1}') == 'a349052808c1317e682cbbb3f1306b5ba5610152cca6a0b541ffc3a5697a82de' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/Reinstall.command"

# Uninstall.command
/bin/cat > "$incoming/Uninstall.command" <<'SOE_FILE_9803f39b00c973434540f05c'
#!/bin/zsh -f
emulate -LR zsh
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
print 'Safe Online Exam Logs — Uninstall'
result=0
if (( EUID != 0 )); then
  /usr/bin/sudo -- /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' uninstall || result=$?
else
  /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' uninstall || result=$?
fi
if (( result != 0 )); then print -u2 'The command did not complete. Review the message above.'; fi
if [[ -t 0 && -t 1 ]]; then read -r '?Press Return to close this window.'; fi
exit $result
SOE_FILE_9803f39b00c973434540f05c
[[ $(/usr/bin/shasum -a 256 < "$incoming/Uninstall.command" | /usr/bin/awk '{print $1}') == '9803f39b00c973434540f05cb42cd271a3e6e8aa1b979faecca3aca9babea38e' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/Uninstall.command"

# Pause.command
/bin/cat > "$incoming/Pause.command" <<'SOE_FILE_2a39f3c5adbf03da599f7708'
#!/bin/zsh -f
emulate -LR zsh
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
print 'Safe Online Exam Logs — Pause'
result=0
if (( EUID != 0 )); then
  /usr/bin/sudo -- /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' pause || result=$?
else
  /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' pause || result=$?
fi
if (( result != 0 )); then print -u2 'The command did not complete. Review the message above.'; fi
if [[ -t 0 && -t 1 ]]; then read -r '?Press Return to close this window.'; fi
exit $result
SOE_FILE_2a39f3c5adbf03da599f7708
[[ $(/usr/bin/shasum -a 256 < "$incoming/Pause.command" | /usr/bin/awk '{print $1}') == '2a39f3c5adbf03da599f7708b0cde4bbdf8f47fcfcfd7b10ef88c18c2f1d23a6' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/Pause.command"

# Resume.command
/bin/cat > "$incoming/Resume.command" <<'SOE_FILE_60eb70712950b1eccdae8731'
#!/bin/zsh -f
emulate -LR zsh
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
print 'Safe Online Exam Logs — Resume'
result=0
if (( EUID != 0 )); then
  /usr/bin/sudo -- /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' resume || result=$?
else
  /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' resume || result=$?
fi
if (( result != 0 )); then print -u2 'The command did not complete. Review the message above.'; fi
if [[ -t 0 && -t 1 ]]; then read -r '?Press Return to close this window.'; fi
exit $result
SOE_FILE_60eb70712950b1eccdae8731
[[ $(/usr/bin/shasum -a 256 < "$incoming/Resume.command" | /usr/bin/awk '{print $1}') == '60eb70712950b1eccdae873183dcdf078401e102d8a01885162349f277259e4a' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }
/bin/zsh -n "$incoming/Resume.command"

# Read Me.txt
/bin/cat > "$incoming/Read Me.txt" <<'SOE_FILE_d468b5722454097f607628a0'
Safe Online Exam Logs

Double-click a command to open it in Terminal. Administrator authentication is requested by sudo. Touch ID is available if your Mac already enables it for sudo. No authentication settings are changed by this installer.

Collect Now.command — run a bounded collection immediately; Safe Exam Browser must be closed and collection must not be paused.
Status.command — show local version, enrollment, collection status and last contact.
Update.command — install a newer checksum-verified release from this Mac's configured HTTPS service.
Reinstall.command — repair the current release offline, preserving enrollment and queued logs.
Uninstall.command — remove the collector; attempt server revocation when online.
Pause.command / Resume.command — control local collection.

bin: internal collector code
support: private recovery scripts
credentials, state, staging: private runtime data

The dashboard queues remote collection for the next check-in (normally every 30 minutes while awake). Update and removal can also be delivered through Jamf using the scripts in Enrollment → Device management. No PATH command is installed.
SOE_FILE_d468b5722454097f607628a0
[[ $(/usr/bin/shasum -a 256 < "$incoming/Read Me.txt" | /usr/bin/awk '{print $1}') == 'd468b5722454097f607628a0678b9ddd63e98c22ca4232ea5a20696154519715' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }

# collector.plist
/bin/cat > "$incoming/collector.plist" <<'SOE_FILE_5e565125ce1a16ee96bca5f3'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.soe.diagnostics.collector</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-f</string><string>/Library/Application Support/SOEDiagnostics/bin/soe-diagnostics</string><string>tick</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>1800</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>LowPriorityIO</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>StandardOutPath</key><string>/Library/Logs/SOEDiagnostics/collector.log</string>
  <key>StandardErrorPath</key><string>/Library/Logs/SOEDiagnostics/collector.log</string>
</dict></plist>
SOE_FILE_5e565125ce1a16ee96bca5f3
[[ $(/usr/bin/shasum -a 256 < "$incoming/collector.plist" | /usr/bin/awk '{print $1}') == '5e565125ce1a16ee96bca5f3726e76bd8293c197402a1aaa6651726da088683d' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }

/usr/bin/plutil -lint "$incoming/collector.plist" >/dev/null
if [[ -f "$ROOT/state/ledger.sqlite" ]]; then
  schema=$(/usr/bin/sqlite3 "$ROOT/state/ledger.sqlite" 'PRAGMA user_version;')
  [[ $schema -le 1 ]] || { print -u2 'Database newer than collector; refusing downgrade'; exit 1; }
fi
# Keep a readable, bootstrap-free recovery copy. Its private directory is root-only.
[[ -f $0 && ! -L $0 ]] || { print -u2 'Run the installer from a saved file'; exit 1; }
/usr/bin/sed '/^# BEGIN ENROLLMENT BOOTSTRAP$/,/^# END ENROLLMENT BOOTSTRAP$/d' "$0" > "$incoming/support/installer.zsh"
/usr/bin/shasum -a 256 < "$incoming/support/installer.zsh" | /usr/bin/awk '{print $1}' > "$incoming/support/installer.zsh.sha256"
/usr/bin/shasum -a 256 < "$incoming/support/uninstall.zsh" | /usr/bin/awk '{print $1}' > "$incoming/support/uninstall.zsh.sha256"
stop_job
if [[ -d "$ROOT/bin" ]]; then
  /bin/rm -rf "$ROOT/previous"; /bin/mkdir "$ROOT/previous"; /bin/mv "$ROOT/bin" "$ROOT/previous/bin"
fi
/bin/mv "$incoming/bin" "$ROOT/bin"
/bin/rm -rf "$ROOT/support"; /bin/mv "$incoming/support" "$ROOT/support"
/bin/chmod -R 755 "$ROOT/bin"
/bin/chmod -R 700 "$ROOT/support"
/bin/chmod 755 "$ROOT"
/bin/chmod 700 "$ROOT/credentials" "$ROOT/state" "$ROOT/staging" "$LOGS"
safe_path "$ROOT/Collect Now.command"; /bin/mv "$incoming/Collect Now.command" "$ROOT/Collect Now.command"; /bin/chmod 755 "$ROOT/Collect Now.command"
safe_path "$ROOT/Status.command"; /bin/mv "$incoming/Status.command" "$ROOT/Status.command"; /bin/chmod 755 "$ROOT/Status.command"
safe_path "$ROOT/Update.command"; /bin/mv "$incoming/Update.command" "$ROOT/Update.command"; /bin/chmod 755 "$ROOT/Update.command"
safe_path "$ROOT/Reinstall.command"; /bin/mv "$incoming/Reinstall.command" "$ROOT/Reinstall.command"; /bin/chmod 755 "$ROOT/Reinstall.command"
safe_path "$ROOT/Uninstall.command"; /bin/mv "$incoming/Uninstall.command" "$ROOT/Uninstall.command"; /bin/chmod 755 "$ROOT/Uninstall.command"
safe_path "$ROOT/Pause.command"; /bin/mv "$incoming/Pause.command" "$ROOT/Pause.command"; /bin/chmod 755 "$ROOT/Pause.command"
safe_path "$ROOT/Resume.command"; /bin/mv "$incoming/Resume.command" "$ROOT/Resume.command"; /bin/chmod 755 "$ROOT/Resume.command"
safe_path "$ROOT/Read Me.txt"; /bin/mv "$incoming/Read Me.txt" "$ROOT/Read Me.txt"; /bin/chmod 644 "$ROOT/Read Me.txt"

if [[ ! -f "$ROOT/config.json" ]]; then
  print -r -- '{"_soe_init":true}' > "$incoming/config.json"
  /usr/bin/plutil -insert schemaVersion -integer 1 "$incoming/config.json"
  /usr/bin/plutil -remove _soe_init "$incoming/config.json"
  /usr/bin/plutil -insert apiOrigin -string "$API_ORIGIN" "$incoming/config.json"
  /usr/bin/plutil -convert json "$incoming/config.json"
  /bin/mv "$incoming/config.json" "$ROOT/config.json"
fi
/bin/chmod 600 "$ROOT/config.json"
/bin/mkdir -p /Library/LaunchDaemons
/bin/mv "$incoming/collector.plist" "$PLIST"
/bin/chmod 644 "$PLIST"
/usr/sbin/chown -R root:wheel "$ROOT" "$LOGS"
/usr/sbin/chown root:wheel "$PLIST"
print -r -- '0.2.1' > "$ROOT/state/installed-version"
/bin/launchctl bootstrap system "$PLIST"
/bin/zsh -f "$ROOT/bin/soe-diagnostics" status --json
print 'Safe Online Exam Logs installed. Commands are in the Application Support folder.'
