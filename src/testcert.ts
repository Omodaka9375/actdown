import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** openssl candidates: PATH first, then the copy bundled with Git for Windows. */
function opensslBin(): string | null {
  const candidates = [
    "openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  ];
  for (const c of candidates) {
    if (c !== "openssl" && !existsSync(c)) continue;
    try {
      execFileSync(c, ["version"], { stdio: "ignore" });
      return c;
    } catch {
      // not runnable; try the next candidate
    }
  }
  return null;
}

/**
 * Generate a self-signed certificate/key pair for the TLS tests via
 * `openssl` (GitHub runners ship it; Git for Windows bundles one). Throws
 * when no openssl is available; the TLS test skips in that case.
 * Test-only helper, not part of the library surface.
 */
export function selfSignedCert(commonName = "localhost"): { cert: string; key: string } {
  const bin = opensslBin();
  if (bin === null) throw new Error("openssl not available");
  const dir = mkdtempSync(join(tmpdir(), "actdown-cert-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync(
      bin,
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPath,
        "-days", "2", "-subj", `/CN=${commonName}`,
        "-addext", `subjectAltName=DNS:${commonName},IP:127.0.0.1`,
      ],
      { stdio: "ignore" },
    );
    return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
