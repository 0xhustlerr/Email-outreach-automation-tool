// A saved Signature must come back on the next read (that is what the Accounts
// editor opens with) and survive Reconnect. Runs against a throwaway database:
// lib/db.ts opens <cwd>/.data/app.db, so the test moves into a temp dir first.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sig-store-"));
let store: typeof import("./identities-store");

beforeAll(async () => {
  process.chdir(tmp);
  store = await import("./identities-store");
  store.upsertStoredIdentity({ email: "Ann@Example.com", name: "Ann", smtpPass: "app-password-1234" });
});

afterAll(async () => {
  const { db } = await import("./db");
  db.close();
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ann = () => store.getStoredIdentity("ann@example.com")!;

describe("Signature storage", () => {
  it("starts empty, on every email", () => {
    expect(ann().signature).toBe("");
    expect(ann().signatureScope).toBe("all");
  });

  it("reads back what was saved", () => {
    expect(store.setIdentitySignature("ann@example.com", "<b>Ann</b>\nAcme", "openers")).toBe(true);
    expect(ann().signature).toBe("<b>Ann</b>\nAcme");
    expect(ann().signatureScope).toBe("openers");
    // The snapshot the Accounts page reads is built from this list.
    expect(store.listStoredIdentities()[0].signature).toBe("<b>Ann</b>\nAcme");
  });

  it("survives Reconnect (re-adding the account)", () => {
    store.upsertStoredIdentity({ email: "ann@example.com", name: "Ann L", smtpPass: "new-password-5678" });
    expect(ann().signature).toBe("<b>Ann</b>\nAcme");
    expect(ann().signatureScope).toBe("openers");
  });

  it("clears with an empty signature", () => {
    store.setIdentitySignature("ann@example.com", "", "all");
    expect(ann().signature).toBe("");
  });

  it("reports an unknown account instead of saving nothing silently", () => {
    expect(store.setIdentitySignature("nobody@example.com", "x", "all")).toBe(false);
  });
});
