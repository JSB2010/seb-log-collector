#!/bin/zsh -f
# Runs as a separate, transient launchd job so replacing/removing the main job
# cannot kill the acknowledgment worker. Its private credentials expire locally.
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL EXTENDED_GLOB
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset CDPATH ENV BASH_ENV
typeset -r ROOT='/Library/Application Support/SOEDiagnostics'
[[ $EUID == 0 ]] || exit 1
work=${1:-}
[[ $work == /private/var/tmp/SafeOnlineExamLogs-management.[A-Za-z0-9]## && -d $work && ! -L $work && $(/usr/bin/stat -f '%u:%Lp' "$work") == 0:700 ]] || exit 1
value() { /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null; }
id=''; label=''; child=''; watchdog=''; result=install_failed
finish() {
  [[ -z $child ]] || /bin/kill -TERM "$child" 2>/dev/null || true
  [[ -z $watchdog ]] || /bin/kill -TERM "$watchdog" 2>/dev/null || true
  if [[ -f "$ROOT/state/management-active" && $(<"$ROOT/state/management-active") == $id ]]; then
    /bin/rm -f "$ROOT/state/management-active"
    # This worker has exited; do not leave Status.command showing it as running.
    if [[ -f "$ROOT/state/outcome" && $(<"$ROOT/state/outcome") == management_running ]]; then
      print -r -- idle > "$ROOT/state/management-outcome.$id"
      /bin/mv -f "$ROOT/state/management-outcome.$id" "$ROOT/state/outcome"
    fi
  fi
  /bin/rm -rf "$work"
  [[ -z $label ]] || /bin/launchctl bootout "system/$label" 2>/dev/null || true
}
trap finish EXIT
trap 'report failed "$result" || true; exit 143' TERM INT
id=$(value "$work/command.json" id); action=$(value "$work/command.json" action); origin=$(value "$work/command.json" origin)
[[ $id == [a-f0-9-]## && ${#id} == 36 && ( $action == update || $action == uninstall ) ]] || exit 1
[[ $origin == https://* && $origin != *[$'\n\r\t "\\']* && ${origin#https://} != */* && ${origin#https://} != *[@?#]* ]] || exit 1
label="org.soe.diagnostics.management.$id"
# Delay until the main collector has returned and released its ledger lock.
/bin/sleep 5
worker_pid=$$
( trap '/bin/kill -TERM "$sleeper" 2>/dev/null || true' TERM; /bin/sleep 300 & sleeper=$!; wait "$sleeper"; /bin/kill -TERM "$worker_pid" 2>/dev/null ) >/dev/null 2>&1 & watchdog=$!
token="$(value "$work/device.json" installationId).$(value "$work/device.json" secret)"
[[ $token == [a-f0-9-]##.[A-Za-z0-9_-]## ]] || exit 1
print -r -- "url = \"$origin/api/device/v1/commands/$id/ack\"" > "$work/ack.curl"
print -r -- "header = \"Authorization: Bearer $token\"" >> "$work/ack.curl"
print -r -- 'header = "Content-Type: application/json"' >> "$work/ack.curl"
print -r -- 'request = "POST"' >> "$work/ack.curl"
print -r -- "data-binary = \"@$work/ack.json\"" >> "$work/ack.curl"
print -r -- "output = \"$work/response.json\"" >> "$work/ack.curl"
unset token
ack() {
  local attempt code
  for attempt in 1 2 3; do
    code=$(/usr/bin/curl -q --config "$work/ack.curl" --silent --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 20 --max-filesize 262144 --write-out '%{http_code}' 2>/dev/null) || code=000
    [[ $code == 2<-> ]] && return 0
    [[ $code == 000 || $code == 5<-> ]] || return 1
    /bin/sleep 2
  done
  return 1
}
report() {
  local state=$1 outcome=$2 version=${3:-} body
  body="{\"state\":\"$state\",\"result\":\"$outcome\"${version:+,\"version\":\"$version\"}}"
  print -rn -- "$body" > "$work/ack.json"
  if ack; then return 0; fi
  # Update results can be retried by the next check-in. Removal has no daemon
  # left to retry: the server stays unconfirmed if every bounded ACK fails.
  if [[ -d "$ROOT/state" && ! -L "$ROOT/state" ]]; then
    print '{}' > "$work/result.json"
    /usr/bin/plutil -insert id -string "$id" "$work/result.json"
    /usr/bin/plutil -insert body -string "$body" "$work/result.json"
    /bin/mv "$work/result.json" "$ROOT/state/management-result.json"
  fi
  return 1
}
# Keep an active exam intact, including when it starts after the main check-in.
if /usr/bin/pgrep -x 'Safe Exam Browser' >/dev/null 2>&1; then report deferred busy || true; exit 0; fi
print '{"state":"running"}' > "$work/ack.json"
ack || { report failed install_failed || true; exit 1; }
if [[ $action == uninstall ]]; then
  result=uninstall_failed
  SOE_MANAGED_UNINSTALL=1 /bin/zsh -f "$work/uninstall.zsh" & child=$!
  if wait "$child"; then child=''; report completed removed || true; else child=''; report failed uninstall_failed || true; exit 1; fi
else
  version=$(value "$work/command.json" version); expected=$(value "$work/command.json" sha256); route=$(value "$work/command.json" path)
  [[ $version == <->.<->.<-> && ${#version} -le 30 && $expected == [a-f0-9]## && ${#expected} == 64 && $route == "/collector/releases/$version/install.zsh" ]] || { report failed unsupported || true; exit 1; }
  installed=$(<"$ROOT/state/installed-version")
  [[ $installed == <->.<->.<-> ]] || { report failed install_failed || true; exit 1; }
  old=(${(s:.:)installed}); new=(${(s:.:)version})
  for i in 1 2 3; do
    (( 10#${new[$i]} > 10#${old[$i]} )) && break
    (( 10#${new[$i]} >= 10#${old[$i]} )) || { report failed unsupported || true; exit 1; }
  done
  if [[ $installed != $version ]]; then
    if ! /usr/bin/curl -q --fail --silent --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 --max-filesize 2097152 --output "$work/install.zsh" "$origin$route"; then report failed download_failed || true; exit 1; fi
    [[ $(/usr/bin/shasum -a 256 < "$work/install.zsh" | /usr/bin/awk '{print $1}') == $expected ]] || { report failed checksum_mismatch || true; exit 1; }
    /bin/zsh -n "$work/install.zsh" || { report failed install_failed || true; exit 1; }
    /bin/zsh -f "$work/install.zsh" & child=$!
    if wait "$child"; then child=''; else child=''; report failed install_failed || true; exit 1; fi
  fi
  [[ -f "$ROOT/state/installed-version" && $(<"$ROOT/state/installed-version") == $version ]] || { report failed install_failed || true; exit 1; }
  report completed installed "$version" || true
fi
