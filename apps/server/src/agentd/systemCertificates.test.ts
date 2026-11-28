// @effect-diagnostics nodeBuiltinImport:off - the test serves a real TLS gateway and writes a CA file the child process reads.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { afterEach, describe } from "vite-plus/test";

import { askModels } from "../gateway/gatewayKeyModels.ts";
import {
  refreshSystemCertificates,
  trustCertificates,
  trustSystemCertificates,
} from "./systemCertificates.ts";

// Non-secret test CA and the 127.0.0.1 certificate it signed, valid until 2126.
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIBqjCCAU+gAwIBAgIURva6UpQKh90gEpsD7Bc8tLeuPuswCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWYWdlbnRkIGdhdGV3YXkgdGVzdCBDQTAgFw0yNjExMjgxNTIw
NDBaGA8yMTI2MTEwNDE1MjA0MFowITEfMB0GA1UEAwwWYWdlbnRkIGdhdGV3YXkg
dGVzdCBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABDU+ETFjfLFfhYw/Jo7y
G9IXLSblprcNy69iQ31wcBr0ktotMMicna/bzmj3SiDZwB4NOFXVUYgKwDucAhZi
uOujYzBhMB0GA1UdDgQWBBRFBV88FNP0dZtfNhy+NgDEY9lGRDAfBgNVHSMEGDAW
gBRFBV88FNP0dZtfNhy+NgDEY9lGRDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB
/wQEAwICBDAKBggqhkjOPQQDAgNJADBGAiEAm2wWkZZa9FLOy4To4KYBSJMuJ8es
qJEsRAaOTD6zSw8CIQDm/m1iv2s4Y3E04X84ibBF4u0BtVLvpUsv5AAYxtcb5Q==
-----END CERTIFICATE-----
`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguEP4a6xD9uRKgWMZ
o/D/5i+WseVKlkc4HEkzaqC65EChRANCAATtyxveVyPgA+9D4FaXt0l6/PI7Zv76
Sn+vPwSprrIvTRQIqQ0HTGn3KotjpXE/T37YzMIC09pAUnijN4aYdPbV
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBlzCCAT2gAwIBAgIULKZF8/3T+GZQHj7mv6kOkrWUeugwCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWYWdlbnRkIGdhdGV3YXkgdGVzdCBDQTAgFw0yNjExMjgxNTIw
NDBaGA8yMTI2MTEwNDE1MjA0MFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYH
KoZIzj0CAQYIKoZIzj0DAQcDQgAE7csb3lcj4APvQ+BWl7dJevzyO2b++kp/rz8E
qa6yL00UCKkNB0xp9yqLY6VxP09+2MzCAtPaQFJ4ozeGmHT21aNeMFwwDwYDVR0R
BAgwBocEfwAAATAJBgNVHRMEAjAAMB0GA1UdDgQWBBTAByiS7kGvez2tCO1FBoL3
dGinKTAfBgNVHSMEGDAWgBRFBV88FNP0dZtfNhy+NgDEY9lGRDAKBggqhkjOPQQD
AgNIADBFAiAWGvDBkO2MitFTqL07hcLSt8n+a4FISC+9Yhz4DfMt5wIhAPJ5r2sA
JDEHIYcKwx2UHY3FBA1FLynZM/BPOF2429o8
-----END CERTIFICATE-----
`;

const defaultCaCertificates = NodeTls.getCACertificates("default");

afterEach(() => NodeTls.setDefaultCACertificates(defaultCaCertificates));

// A gateway of its own per test: fetch resumes TLS sessions per origin, which skips the check.
const serveGateway = Effect.acquireRelease(
  Effect.promise(async () => {
    const server = NodeHttps.createServer(
      { key: TEST_KEY, cert: TEST_CERT },
      (_request, response) => {
        response.setHeader("content-type", "application/json");
        response.setHeader("connection", "close");
        response.end(JSON.stringify({ data: [{ id: "m1" }] }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const host = `127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
    const ask = askModels({
      base: `https://${host}/v1`,
      name: "Computing Gateway",
      key: null,
    }).pipe(Effect.provide(FetchHttpClient.layer));
    return { server, host, ask };
  }),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

describe("gateway certificates", () => {
  it.effect("a gateway signed by an untrusted CA says its certificate isn't trusted", () =>
    Effect.gen(function* () {
      const { host, ask } = yield* serveGateway;
      const answer = yield* ask;
      assert.strictEqual(answer.kind, "unavailable");
      if (answer.kind !== "unavailable") return;
      assert.isTrue(answer.untrusted);
      assert.include(answer.message, `Computing Gateway's certificate at ${host} isn't trusted`);
      assert.include(answer.message, "certificate store");
      assert.notInclude(answer.message, "Check your connection");

      // Trusting the CA in this running process is enough; no restart.
      trustCertificates([TEST_CA]);
      const trusted = yield* ask;
      assert.strictEqual(trusted.kind, "models");
      if (trusted.kind !== "models") return;
      assert.deepStrictEqual(
        trusted.models.map((model) => model.id),
        ["m1"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("trusting another CA keeps the roots Node started with", () =>
    Effect.sync(() => {
      trustCertificates([TEST_CA]);
      // Node hands back its own PEM text, so compare certificates, not strings.
      const fingerprints = (pems: ReadonlyArray<string>) =>
        new Set(pems.map((pem) => new NodeCrypto.X509Certificate(pem).fingerprint256));
      const now = fingerprints(NodeTls.getCACertificates("default"));
      assert.isTrue(now.has(new NodeCrypto.X509Certificate(TEST_CA).fingerprint256));
      for (const root of fingerprints(defaultCaCertificates)) assert.isTrue(now.has(root));
    }),
  );

  it("agents the server starts trust the system store, unless told otherwise", () => {
    const environment: NodeJS.ProcessEnv = {};
    trustSystemCertificates(environment);
    assert.strictEqual(environment.NODE_USE_SYSTEM_CA, "1");
    const optedOut: NodeJS.ProcessEnv = { NODE_USE_SYSTEM_CA: "0" };
    trustSystemCertificates(optedOut);
    assert.strictEqual(optedOut.NODE_USE_SYSTEM_CA, "0");
  });

  // OpenSSL's SSL_CERT_FILE names the Linux system store; macOS and Windows read their keychains.
  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "a CA added to the system store after start is trusted on the next read",
    () =>
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-system-ca-"));
        const store = NodePath.join(directory, "ca-certificates.crt");
        NodeFS.writeFileSync(store, TEST_CA);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        );
        const { ask } = yield* serveGateway;
        assert.strictEqual((yield* ask).kind, "unavailable");
        yield* refreshSystemCertificates().pipe(
          Effect.provideService(HostProcess.Environment, { ...process.env, SSL_CERT_FILE: store }),
        );
        assert.strictEqual((yield* ask).kind, "models");
      }).pipe(Effect.scoped),
  );
});
