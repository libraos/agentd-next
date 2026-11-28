import { assert, it } from "@effect/vitest";

import { trustSystemCertificates } from "./systemCertificates.ts";

const fakeTls = (system: ReadonlyArray<string>) => {
  const set: Array<ReadonlyArray<string>> = [];
  return {
    set,
    tls: {
      getCACertificates: (type?: string) =>
        type === "system" ? [...system] : ["bundled", "shared"],
      setDefaultCACertificates: (certs: ReadonlyArray<string>) => void set.push(certs),
    },
  };
};

it("trusts the system store beside the bundled roots and has agents trust it too", () => {
  const { tls, set } = fakeTls(["shared", "internal CA"]);
  const env: NodeJS.ProcessEnv = {};
  trustSystemCertificates(tls as never, env);
  assert.deepStrictEqual(set, [["bundled", "shared", "internal CA"]]);
  assert.strictEqual(env.NODE_USE_SYSTEM_CA, "1");
});

it("leaves an explicit NODE_USE_SYSTEM_CA alone", () => {
  const env: NodeJS.ProcessEnv = { NODE_USE_SYSTEM_CA: "0" };
  trustSystemCertificates(fakeTls([]).tls as never, env);
  assert.strictEqual(env.NODE_USE_SYSTEM_CA, "0");
});
