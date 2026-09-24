import { describe, it, expect } from "vitest";
import {
  githubLogin,
  keyAfterEdit,
  keyForManualContact,
  keyFromUrl,
  withScheme,
} from "./contact-key";

describe("keyFromUrl", () => {
  it("keys a GitHub profile by its lowercased login, with or without scheme", () => {
    expect(keyFromUrl("github.com/DanHab99")).toEqual({
      key: "danhab99",
      login: "DanHab99",
      url: "https://github.com/DanHab99",
    });
    expect(keyFromUrl("https://www.github.com/danhab99/some-repo")?.key).toBe("danhab99");
  });

  it("keys any other link by host + path, trailing slash dropped", () => {
    expect(keyFromUrl("https://www.Upwork.com/freelancers/~01ABC/")?.key).toBe(
      "upwork.com/freelancers/~01abc",
    );
  });

  it("rejects blank input", () => {
    expect(keyFromUrl("   ")).toBeNull();
  });
});

describe("githubLogin", () => {
  it("returns the login only for github.com profile links", () => {
    expect(githubLogin("github.com/HumanJBooF")).toBe("HumanJBooF");
    expect(githubLogin("github.com")).toBeNull();
    expect(githubLogin("linkedin.com/in/someone")).toBeNull();
  });
});

describe("keyForManualContact", () => {
  const id = () => "fixed-id";

  it("prefers the GitHub login, matching the key scans save under", () => {
    expect(
      keyForManualContact(
        {
          githubUrl: "github.com/MannYoe",
          upworkUrl: "upwork.com/freelancers/~01",
          linkedinUrl: "linkedin.com/in/manny",
        },
        id,
      ),
    ).toBe("mannyoe");
  });

  it("falls back to Upwork, then LinkedIn", () => {
    expect(
      keyForManualContact(
        { upworkUrl: "upwork.com/freelancers/~01", linkedinUrl: "linkedin.com/in/manny" },
        id,
      ),
    ).toBe("upwork.com/freelancers/~01");
    expect(keyForManualContact({ linkedinUrl: "linkedin.com/in/Manny/" }, id)).toBe(
      "linkedin.com/in/manny",
    );
  });

  it("ignores a GitHub field that isn't a profile link", () => {
    expect(
      keyForManualContact({ githubUrl: "github.com", linkedinUrl: "linkedin.com/in/x" }, id),
    ).toBe("linkedin.com/in/x");
  });

  it("mints a manual: key when no link is given", () => {
    expect(keyForManualContact({}, id)).toBe("manual:fixed-id");
    expect(keyForManualContact({ githubUrl: " ", upworkUrl: "" }, id)).toBe("manual:fixed-id");
  });
});

describe("withScheme", () => {
  it("adds https:// only when no scheme is present, and trims", () => {
    expect(withScheme(" linkedin.com/in/x ")).toBe("https://linkedin.com/in/x");
    expect(withScheme("http://example.com")).toBe("http://example.com");
    expect(withScheme("   ")).toBe("");
  });
});

describe("keyAfterEdit", () => {
  it("moves a card onto the GitHub login's key, where scans save that person", () => {
    expect(keyAfterEdit("manual:abc", "github.com/MannYoe")).toBe("mannyoe");
    expect(keyAfterEdit("upwork.com/freelancers/~01", "https://github.com/x")).toBe("x");
    expect(keyAfterEdit("alice", "github.com/bob")).toBe("bob");
  });

  it("keeps the key when GitHub is blank, invalid, or the same login", () => {
    expect(keyAfterEdit("manual:abc", "")).toBe("manual:abc");
    expect(keyAfterEdit("manual:abc", "github.com")).toBe("manual:abc");
    expect(keyAfterEdit("alice", "github.com/Alice")).toBe("alice");
  });
});
