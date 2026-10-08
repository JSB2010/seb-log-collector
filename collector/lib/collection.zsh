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
