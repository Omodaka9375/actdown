import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Generate a self-signed certificate/key pair for the TLS tests via
 * `openssl` (dev machines and GitHub runners both ship it). Throws when
 * openssl is unavailable; the TLS test skips in that case. Not exported
 * from the library surface: test-only helper kept next to the sources so
 * the dist import path stays regular.
 */
export function selfSignedCert(commonName = "localhost"): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "actdown-cert-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync(
      "openssl",
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
