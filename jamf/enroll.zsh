#!/bin/zsh -f
if [ -z "${ZSH_VERSION:-}" ]; then
  printf '%s\n' 'Safe Online Exam Logs requires zsh. Run: sudo /bin/zsh -f "path/to/script.zsh"' >&2
  exit 2
fi
# Prefer the restricted one-time script downloaded from the enrollment dashboard.
# Alternatively send the bootstrap code to this script over stdin as root.
set -eu
/bin/zsh -f '/Library/Application Support/SOEDiagnostics/bin/soe-diagnostics' enroll --bootstrap-stdin
