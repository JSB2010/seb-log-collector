enroll() {
  local bootstrap installation encoded f="$WORK/device.tmp" b="$WORK/enroll.json" digest serial
  bootstrap=$(/bin/cat); [[ $bootstrap == [A-Za-z0-9_-]## && ${#bootstrap} == 43 ]] || die invalid_bootstrap
  if [[ ! -f $CREDS ]]; then
    /usr/bin/openssl rand 32 > "$WORK/secret.bin" || die random_failed
    encoded=$(/usr/bin/openssl base64 -A -in "$WORK/secret.bin" | /usr/bin/tr '+/' '-_' | /usr/bin/tr -d '=')
    digest=$(hash_file "$WORK/secret.bin"); installation=$(/usr/bin/uuidgen); installation=${installation:l}
    print -r -- "{\"installationId\":\"$installation\",\"secret\":\"$encoded\",\"credentialHash\":\"$digest\"}" > "$f"
    atomic_json "$f" "$CREDS"
  fi
  # Reconcile a committed enrollment even if its bootstrap has since expired.
  if http GET /api/device/v1/config; then
    /bin/cp "$CREDS" "$f"; /usr/bin/plutil -replace deviceId -string "$(json_value "$HTTP_RESPONSE" deviceId)" "$f" 2>/dev/null || json_string "$f" deviceId "$(json_value "$HTTP_RESPONSE" deviceId)"; atomic_json "$f" "$CREDS"; set_outcome enrolled; return 0
  fi
  serial=$(/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice | /usr/bin/awk -F '"' '/IOPlatformSerialNumber/{print $(NF-1)}')
  [[ $serial == [A-Za-z0-9-]## ]] || die serial_unavailable
  metadata "$WORK/metadata.json"; json_new "$b"; json_int "$b" schemaVersion 1; json_string "$b" installationId "$(json_value "$CREDS" installationId)"; json_string "$b" credentialHash "$(json_value "$CREDS" credentialHash)"; json_string "$b" serial "$serial"; json_object "$b" metadata "$WORK/metadata.json"; /usr/bin/plutil -convert json "$b"
  bootstrap_http "$bootstrap" "$b" || die enrollment_failed
  /bin/cp "$CREDS" "$f"; json_string "$f" deviceId "$(json_value "$HTTP_RESPONSE" deviceId)"; atomic_json "$f" "$CREDS"
  save_setting initial_pending 1; set_outcome enrolled
  print 'Enrollment complete'
}
