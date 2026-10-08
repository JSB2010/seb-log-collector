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
die() { set_outcome "$1" 2>/dev/null || true; print -u2 -- "SOE Diagnostics: $1"; exit 1; }
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
