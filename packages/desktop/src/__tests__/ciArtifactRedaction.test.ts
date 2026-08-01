import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const redactionScript = resolve(repoRoot, "scripts/redact-ci-test-artifacts.mjs");

describe("CI artifact redaction", () => {
  it("redacts every authorization scheme through the end of CRLF log headers", async () => {
    const reportDirectory = await mkdtemp(resolve(tmpdir(), "planweave-ci-header-redaction-"));
    const reportPath = resolve(reportDirectory, "credentials.log");
    const secrets = [
      "basic-token-value",
      "basic-metadata-value",
      "bearer-token-value",
      "bearer-scope-value",
      "AKIAIOSFODNN7EXAMPLE",
      "aws-signature-value",
      "digest-user-value",
      "digest-realm-value",
      "digest-nonce-value",
      "digest-response-value",
      "digest-response-after-diagnostic",
      "negotiate-token-value",
      "ntlm-token-value",
      "proxy-cookie-value",
      "csrf-cookie-value"
    ];

    try {
      await writeFile(
        reportPath,
        [
          "Authorization: Basic basic-token-value metadata=basic-metadata-value",
          "Proxy-Authorization: Bearer bearer-token-value scope=bearer-scope-value",
          "authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260801/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, diagnostic=header-metadata, Signature=aws-signature-value",
          'pRoXy-AuThOrIzAtIoN: Digest username="digest-user-value", realm="digest-realm-value", nonce="digest-nonce-value", diagnostic=header-metadata, response="digest-response-value", response-after-diagnostic="digest-response-after-diagnostic"',
          "Authorization: Negotiate negotiate-token-value",
          "Proxy-Authorization: NTLM ntlm-token-value",
          "Cookie: session=proxy-cookie-value; csrf=csrf-cookie-value",
          "Authorization: Bearer boundary-token",
          "diagnostic=ordinary diagnostic remains"
        ].join("\r\n"),
        "utf8"
      );

      await execFileAsync(process.execPath, [redactionScript, reportDirectory], { cwd: repoRoot });

      const redacted = await readFile(reportPath, "utf8");
      for (const secret of secrets) {
        expect(redacted).not.toContain(secret);
      }
      expect(redacted).not.toContain("boundary-token");
      expect(redacted).not.toContain("diagnostic=header-metadata");
      expect(redacted).not.toContain("response-after-diagnostic");
      expect(redacted).toContain("Authorization: [REDACTED]");
      expect(redacted).toContain("Proxy-Authorization: [REDACTED]");
      expect(redacted).toContain("authorization: [REDACTED]");
      expect(redacted).toContain("pRoXy-AuThOrIzAtIoN: [REDACTED]");
      expect(redacted).toContain("Cookie: [REDACTED]");
      expect(redacted).toContain("Authorization: [REDACTED]\r\nProxy-Authorization: [REDACTED]");
      expect(redacted).toContain("authorization: [REDACTED]\r\npRoXy-AuThOrIzAtIoN: [REDACTED]");
      expect(redacted).toContain("diagnostic=ordinary diagnostic remains");
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });

  it("redacts complete credential headers and preserves ordinary diagnostics", async () => {
    const reportDirectory = await mkdtemp(resolve(tmpdir(), "planweave-ci-artifact-redaction-"));
    const reportPath = resolve(reportDirectory, "failure.json");
    const xmlReportPath = resolve(reportDirectory, "failure.xml");
    const logReportPath = resolve(reportDirectory, "failure.log");
    const plainTextReportPath = resolve(reportDirectory, "failure.txt");
    const secrets = [
      "bearer-token-value",
      "dXNlcjpwYXNzd29yZA==",
      "proxy-token-value",
      "session-cookie-value",
      "csrf-cookie-value",
      "query-token-value",
      "private-key-material",
      "private-pipe-descriptor",
      "/Users/example/private/failure.xml",
      "C:\\Users\\example\\private\\failure.xml",
      "xml-bearer-token",
      "xml-basic-token",
      "xml-cookie-one",
      "xml-cookie-two",
      "lower-log-token",
      "log-cookie-one",
      "log-cookie-two",
      "upper-plain-basic-token",
      "equals-plain-token",
      "plain-cookie-one",
      "plain-cookie-two",
      "json quoted secret value",
      "json quoted proxy secret",
      "json-cookie-one",
      "json-cookie-two",
      "immediate-token",
      "raw-unclosed-secret",
      "json-escaped-unclosed-authorization",
      "json-escaped-unclosed-proxy",
      "raw-unclosed-cookie",
      "escaped-unclosed-cookie",
      "cookie-comma-one",
      "cookie-comma-two"
    ];

    try {
      await Promise.all([
        writeFile(
          reportPath,
          JSON.stringify({
            requestHeaders: [
              "Authorization: Bearer bearer-token-value",
              "Authorization: Basic dXNlcjpwYXNzd29yZA==",
              "Proxy-Authorization: Bearer proxy-token-value",
              "Cookie: session=session-cookie-value; csrf=csrf-cookie-value"
            ],
            jsonQuotedAuthorization: 'Authorization: Bearer "json quoted secret value"',
            jsonQuotedProxyAuthorization: 'Proxy-Authorization: Basic "json quoted proxy secret"',
            jsonQuotedCookie: 'Cookie: "session=json-cookie-one; csrf=json-cookie-two"',
            jsonEscapedUnclosedAuthorization:
              'Authorization: Bearer \\"json-escaped-unclosed-authorization',
            jsonEscapedUnclosedProxy: 'Proxy-Authorization: Basic \\"json-escaped-unclosed-proxy',
            jsonEscapedUnclosedCookie: 'Cookie: \\"session=escaped-unclosed-cookie',
            sensitiveQuery:
              "https://example.test/callback?client_id=public-client&token=query-token-value&mode=read",
            pem: "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
            descriptor: "private-pipe-descriptor",
            unixPath: "/Users/example/private/failure.xml",
            windowsPath: "C:\\Users\\example\\private\\failure.xml",
            ordinaryQuery: "https://example.test/search?q=public+term&page=2&sort=recent",
            diagnostic: "Connection retry scheduled after 250ms"
          }),
          "utf8"
        ),
        writeFile(
          xmlReportPath,
          '<testsuite Authorization="Bearer xml-bearer-token" Proxy-Authorization="Basic xml-basic-token" Cookie="session=xml-cookie-one; csrf=xml-cookie-two" diagnostic="xml diagnostic remains" />',
          "utf8"
        ),
        writeFile(
          logReportPath,
          "authorization=Bearer lower-log-token\ndiagnostic=log diagnostic remains\ncookie=log-cookie-one; csrf=log-cookie-two\ncontext;Authorization: Bearer immediate-token\n",
          "utf8"
        ),
        writeFile(
          plainTextReportPath,
          'PROXY-AUTHORIZATION: Basic upper-plain-basic-token\nplain diagnostic=plain diagnostic remains\nAuthorization=Bearer equals-plain-token\nCookie: session=plain-cookie-one; csrf=plain-cookie-two\nAuthorization: "Bearer raw-unclosed-secret\nnext diagnostic after malformed authorization\nCookie: "session=raw-unclosed-cookie\nnext diagnostic after malformed cookie\nCookie: a=cookie-comma-one, b=cookie-comma-two; diagnostic=ok\nnext diagnostic after comma cookie\n',
          "utf8"
        )
      ]);

      await execFileAsync(process.execPath, [redactionScript, reportDirectory], { cwd: repoRoot });

      const [redacted, redactedXml, redactedLog, redactedPlainText] = await Promise.all([
        readFile(reportPath, "utf8"),
        readFile(xmlReportPath, "utf8"),
        readFile(logReportPath, "utf8"),
        readFile(plainTextReportPath, "utf8")
      ]);
      for (const secret of secrets) {
        expect(`${redacted}\n${redactedXml}\n${redactedLog}\n${redactedPlainText}`).not.toContain(
          secret
        );
      }
      expect(redacted).toContain("Authorization: [REDACTED]");
      expect(redacted).toContain("Proxy-Authorization: [REDACTED]");
      expect(redacted).toContain("Cookie: [REDACTED]");
      expect(redacted).toContain("token=[REDACTED]");
      expect(redacted).toContain("[REDACTED PEM]");
      expect(redacted).toContain("<redacted-user-path>");
      expect(redacted).toContain("https://example.test/search?q=public+term&page=2&sort=recent");
      expect(redacted).toContain("Connection retry scheduled after 250ms");
      expect(JSON.parse(redacted)).toMatchObject({
        jsonQuotedAuthorization: "Authorization: [REDACTED]",
        jsonQuotedProxyAuthorization: "Proxy-Authorization: [REDACTED]",
        jsonQuotedCookie: 'Cookie: "[REDACTED]"',
        jsonEscapedUnclosedAuthorization: "Authorization: [REDACTED]",
        jsonEscapedUnclosedProxy: "Proxy-Authorization: [REDACTED]",
        jsonEscapedUnclosedCookie: "Cookie: [REDACTED]"
      });
      expect(redactedXml).toContain('Authorization="[REDACTED]"');
      expect(redactedXml).toContain('Proxy-Authorization="[REDACTED]"');
      expect(redactedXml).toContain('Cookie="[REDACTED]"');
      expect(redactedXml).toContain('diagnostic="xml diagnostic remains"');
      expect(redactedLog).toContain("authorization=[REDACTED]");
      expect(redactedLog).toContain("diagnostic=log diagnostic remains");
      expect(redactedLog).toContain("cookie=[REDACTED]");
      expect(redactedLog).toContain("context;Authorization: [REDACTED]");
      expect(redactedPlainText).toContain("PROXY-AUTHORIZATION: [REDACTED]");
      expect(redactedPlainText).toContain("plain diagnostic=plain diagnostic remains");
      expect(redactedPlainText).toContain("Authorization=[REDACTED]");
      expect(redactedPlainText).toContain("Cookie: [REDACTED]");
      expect(redactedPlainText).toContain("next diagnostic after malformed authorization");
      expect(redactedPlainText).toContain("next diagnostic after malformed cookie");
      expect(redactedPlainText).toContain("next diagnostic after comma cookie");
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });
});
