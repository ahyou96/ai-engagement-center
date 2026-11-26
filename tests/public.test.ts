import { afterAll, describe, expect, it } from "vitest";
import { freshDb } from "./setup";
import { one } from "../src/lib/db";
import { verifyPassword } from "../src/lib/auth";

describe("public deployment hardening (AEC_PUBLIC=1)", () => {
  afterAll(() => { delete process.env.AEC_PUBLIC; delete process.env.AEC_DEMO_PASSWORD; });
  it("never seeds the demo password or the demo ingestion key", () => {
    process.env.AEC_PUBLIC = "1"; process.env.AEC_DEMO_PASSWORD = "a-strong-host-secret-42";
    freshDb("public", 300, 3000);
    const u = one<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = 'admin@aec.local'")!;
    expect(verifyPassword("demo1234", u.password_hash)).toBe(false);
    expect(verifyPassword("a-strong-host-secret-42", u.password_hash)).toBe(true);
    expect(one("SELECT 1 FROM api_keys WHERE id = 'key_demo'")).toBeUndefined();
  });
  it("rejects a weak configured password", () => {
    process.env.AEC_PUBLIC = "1"; process.env.AEC_DEMO_PASSWORD = "short";
    expect(() => freshDb("public2", 300, 3000)).toThrow(/at least 12/);
  });
});
