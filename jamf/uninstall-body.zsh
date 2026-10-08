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
print 'SOE Diagnostics removed locally. Confirm server-side revocation in the dashboard.'
