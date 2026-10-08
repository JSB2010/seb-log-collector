typeset -r LEDGER="$STATE/ledger.sqlite"
ledger_sql() {
  local code=0
  # SQLite parser errors may echo SQL containing source-user/device metadata.
  /usr/bin/sqlite3 -batch -bail "$LEDGER" "$1" 2>/dev/null || code=$?
  if (( code != 0 )); then set_error ledger_error; print -u2 "SOE Diagnostics: ledger operation failed (SQLite exit $code)"; fi
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
