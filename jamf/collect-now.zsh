#!/bin/zsh -f
if [ -z "${ZSH_VERSION:-}" ]; then
  printf '%s\n' 'Safe Online Exam Logs requires zsh. Run: sudo /bin/zsh -f "path/to/script.zsh"' >&2
  exit 2
fi
set -eu
/bin/zsh -f '/Library/Application Support/SOEDiagnostics/bin/soe-diagnostics' collect --now
