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
    .replace(
      /((?:token|id[_ -]?token|state|code|access[_ -]?code|password|cookie|authorization|config[_ -]?key(?:[_ -]?hash)?|private[_ -]?key|proof[_ -]?token|refresh[_ -]?token|access[_ -]?token|bootstrap|session[_ -]?token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[redacted]"
    );
}
export interface LogFinding {
  stage: string;
  reasonCode: string;
  line: number;
  source: "seb_log";
  message: string;
}
export interface LogAnalysis {
  parserVersion: number;
  markers: string[];
  findings: LogFinding[];
  lineCount: number;
  timestampBasis: "client_log_uncertain";
}
export function analyzeLog(text: string): LogAnalysis {
  const markers = new Set<string>();
  const findings: LogFinding[] = [];
  const lines = text.split(/\r?\n/);
  const patterns: [RegExp, string, string, string][] = [
    [
      /unable to decrypt|decryption (?:failed|error)|no (?:matching|valid).*identity|private (?:key|identity).*not found/i,
      "configuration.decryption",
      "SEB_DECRYPTION_REJECTED",
      "Client reported configuration decryption failure"
    ],
    [
      /didFinishLaunchingWithSettings|INITIALIZING SEB.*STARTING SESSION/i,
      "client.startup",
      "SEB_STARTUP_OBSERVED",
      "Client startup observed"
    ],
    [
      /Open MainBrowserWindow|main browser window.*(?:opened|created)/i,
      "client.window",
      "SEB_WINDOW_OBSERVED",
      "Client browser window creation reported"
    ],
    [
      /navigation.*(?:failed|error)|didFailProvisionalNavigation/i,
      "client.navigation",
      "SEB_NAVIGATION_FAILED",
      "Client reported navigation failure"
    ],
    [
      /(?:URL|url).*filter.*(?:blocked|denied)|not allowed.*URL/i,
      "client.navigation",
      "SEB_URL_FILTER_REJECTED",
      "Client reported URL filter rejection"
    ],
    [
      /csrf|invalid authenticity token/i,
      "canvas.request",
      "CANVAS_CSRF_REPORTED",
      "Client log reports a Canvas request-integrity error"
    ],
    [
      /terminating SEB|SEB.*(?:crash|fatal exception)/i,
      "client.termination",
      "SEB_TERMINATION_REPORTED",
      "Client termination reported"
    ]
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(
      /(?:[?&]diagnostic=|diagnostic[-_ ](?:launch[-_ ])?marker[ :=]+|_diagnostic_)([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi
    ))
      if (markers.size < 32) markers.add(m[1].toLowerCase());
    for (const [pattern, stage, reasonCode, message] of patterns)
      if (findings.length < 200 && pattern.test(lines[i]))
        findings.push({ stage, reasonCode, line: i + 1, source: "seb_log", message });
  }
  return {
    parserVersion: 1,
    markers: [...markers],
    findings,
    lineCount: lines.length,
    timestampBasis: "client_log_uncertain"
  };
}
