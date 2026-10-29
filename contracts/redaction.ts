export function redactDiagnosticText(input: string): string {
  return input
    .replace(/(?:https?|sebs?):\/\/[^\s<>"']+/gi, (value) => {
      try {
        const u = new URL(value.replace(/^sebs?:/, "https:"));
        u.username = "";
        u.password = "";
        u.hash = "";
        u.pathname = u.pathname.replace(
          /(\/seb\/(?:session|launch-handoff|exit\/(?:session|quit|complete))\/)([^/]+(?:\/[^/]+)?\/)?[^/]+$/i,
          "$1[redacted]"
        );
        const marker = u.searchParams.get("diagnostic");
        u.search = "";
        if (marker && /^[0-9a-f-]{36}$/i.test(marker)) u.searchParams.set("diagnostic", marker);
        return u.toString();
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:cookie|set-cookie|authorization)["']?\s*[=:]\s*)[^\r\n]*/gi, "$1[redacted]")
    .replace(
      /(["']?(?:[a-z_]*(?:password|secret)|token|id[_ -]?token|state|code|access[_ -]?code|cookie|authorization|config[_ -]?key(?:[_ -]?hash)?|browser[_ -]?exam[_ -]?key|exam[_ -]?key|private[_ -]?key|proof[_ -]?token|refresh[_ -]?token|access[_ -]?token|bootstrap|session[_ -]?token)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
      "$1[redacted]"
    );
}
export const PARSER_VERSION = 2;
export interface LogFinding {
  stage: string;
  reasonCode: string;
  line: number;
  source: "seb_log";
  message: string;
  category?: string;
  severity?: "info" | "warning" | "error";
  endLine?: number;
  occurrences?: number;
  lines?: number[];
  observedAt?: string;
  rawTimestamp?: string;
  timestampBasis?: "explicit_offset" | "client_log_uncertain";
}
export interface LogAnalysis {
  parserVersion: number;
  markers: string[];
  findings: LogFinding[];
  lineCount: number;
  timestampBasis: "client_log_uncertain" | "explicit_offset" | "mixed";
}
type Rule = [RegExp, string, string, string, "info" | "warning" | "error"];
const rules: Rule[] = [
  [
    /unable to decrypt|decryption (?:failed|error)|no (?:matching|valid).*identity|private (?:key|identity).*not found/i,
    "configuration.decryption",
    "SEB_DECRYPTION_REJECTED",
    "Client reported configuration decryption failure",
    "error"
  ],
  [
    /didFinishLaunchingWithSettings|INITIALIZING SEB.*STARTING SESSION/i,
    "client.startup",
    "SEB_STARTUP_OBSERVED",
    "Client startup observed",
    "info"
  ],
  [
    /Open MainBrowserWindow|main browser window.*(?:opened|created)/i,
    "client.window",
    "SEB_WINDOW_OBSERVED",
    "Client browser window creation reported",
    "info"
  ],
  [
    /navigation.*(?:failed|error)|didFailProvisionalNavigation/i,
    "client.navigation",
    "SEB_NAVIGATION_FAILED",
    "Client reported navigation failure",
    "error"
  ],
  [
    /(?:URL|url).*filter.*(?:blocked|denied)|not allowed.*URL/i,
    "client.navigation",
    "SEB_URL_FILTER_REJECTED",
    "Client reported URL filter rejection",
    "warning"
  ],
  [
    /csrf|invalid authenticity token/i,
    "canvas.request",
    "CANVAS_CSRF_REPORTED",
    "Client log reports a Canvas request-integrity error",
    "error"
  ],
  [
    /certificate.*(?:invalid|expired|untrusted)|SSL.*(?:error|failed)|TLS.*(?:error|failed)|NSURLErrorServerCertificate/i,
    "client.network",
    "SEB_TLS_ERROR_REPORTED",
    "Client reported a certificate or TLS error",
    "error"
  ],
  [
    /network.*(?:unreachable|connection lost)|NSURLErrorTimedOut|connection.*(?:timed out|refused)|NSURLErrorNotConnectedToInternet/i,
    "client.network",
    "SEB_NETWORK_ERROR_REPORTED",
    "Client reported a network connection error",
    "error"
  ],
  [
    /authentication.*(?:failed|rejected)|HTTP(?: status)?[ :=]+(?:401|403)\b/i,
    "client.authentication",
    "SEB_AUTH_ERROR_REPORTED",
    "Client reported an authentication or access rejection",
    "warning"
  ],
  [
    /AAC.*(?:failed|denied)|assessment.*mode.*(?:failed|denied)/i,
    "client.lockdown",
    "SEB_LOCKDOWN_ERROR_REPORTED",
    "Client reported assessment-mode failure",
    "error"
  ],
  [
    /SEB.*(?:crash|fatal exception)|uncaught exception|EXC_BAD_ACCESS/i,
    "client.termination",
    "SEB_FATAL_ERROR_REPORTED",
    "Client reported a fatal error; cause is unconfirmed",
    "error"
  ],
  [
    /terminating SEB|SEB.*(?:normal shutdown|terminated normally|session ended|quit requested)/i,
    "client.termination",
    "SEB_TERMINATION_REPORTED",
    "Client termination observed; this does not establish a crash",
    "info"
  ]
];
/** Streaming, bounded deterministic observations. No raw text enters findings. */
export class LogAnalyzer {
  private markers = new Set<string>();
  private findings = new Map<string, LogFinding>();
  private lineCount = 0;
  consume(line: string, number = this.lineCount + 1) {
    this.lineCount = number;
    for (const m of line.matchAll(
      /(?:[?&]diagnostic=|diagnostic[-_ ](?:launch[-_ ])?marker[ :=]+|_diagnostic_)([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi
    ))
      if (this.markers.size < 32) this.markers.add(m[1].toLowerCase());
    const rawTimestamp = /(?:^|\[)(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(
      line
    )?.[1];
    const explicit = rawTimestamp && /(?:Z|[+-]\d{2}:?\d{2})$/.test(rawTimestamp);
    const at = explicit ? Date.parse(rawTimestamp.replace(",", ".").replace(" ", "T")) : NaN;
    for (const [pattern, stage, reasonCode, message, severity] of rules) {
      if (!pattern.test(line)) continue;
      const existing = this.findings.get(reasonCode);
      if (existing) {
        existing.occurrences = (existing.occurrences || 1) + 1;
        existing.endLine = number;
        if (existing.lines!.length < 32) existing.lines!.push(number);
      } else if (this.findings.size < 200)
        this.findings.set(reasonCode, {
          stage,
          reasonCode,
          message,
          severity,
          category: stage.split(".")[0],
          line: number,
          endLine: number,
          source: "seb_log",
          occurrences: 1,
          lines: [number],
          rawTimestamp,
          timestampBasis: Number.isFinite(at) ? "explicit_offset" : "client_log_uncertain",
          observedAt: Number.isFinite(at) ? new Date(at).toISOString() : undefined
        });
    }
  }
  result(): LogAnalysis {
    const findings = [...this.findings.values()];
    const certain = findings.filter((f) => f.observedAt).length;
    return {
      parserVersion: PARSER_VERSION,
      markers: [...this.markers],
      findings,
      lineCount: this.lineCount,
      timestampBasis: !certain ? "client_log_uncertain" : certain === findings.length ? "explicit_offset" : "mixed"
    };
  }
}
export function analyzeLog(text: string): LogAnalysis {
  const parser = new LogAnalyzer();
  text.split(/\r?\n/).forEach((line) => parser.consume(line));
  return parser.result();
}

/** Per-file state prevents multiline plist/PEM credentials leaking in previews. */
export class DiagnosticTextRedactor {
  private pem = false;
  private plist = false;
  private nextJson = false;
  line(value: string) {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) this.pem = true;
    if (this.pem) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/i.test(value)) this.pem = false;
      return "[redacted private key]";
    }
    if (this.plist) {
      if (/<\/(?:string|data)>/i.test(value)) this.plist = false;
      return "[redacted sensitive setting]";
    }
    if (this.nextJson) {
      this.nextJson = false;
      return "[redacted credential value]";
    }
    const secret =
      "(?:[a-z_]*(?:password|secret)|token|id[_ -]?token|state|code|access[_ -]?code|cookie|authorization|config[_ -]?key(?:[_ -]?hash)?|browser[_ -]?exam[_ -]?key|exam[_ -]?key|private[_ -]?key|proof[_ -]?token|refresh[_ -]?token|access[_ -]?token|bootstrap|session[_ -]?token)";
    const key = new RegExp("<key>\\s*" + secret + "\\s*</key>", "i").exec(value);
    if (key) {
      this.plist = !/<\/(?:string|data)>/i.test(value.slice(key.index + key[0].length));
      return "[redacted sensitive setting]";
    }
    if (new RegExp("[\"\\']" + secret + "[\"\\']\\s*:\\s*$", "i").test(value)) {
      this.nextJson = true;
      return redactDiagnosticText(value);
    }
    return redactDiagnosticText(value);
  }
}
