import { describe, expect, it } from "vitest";
import { MAX_GIVEN_NAME_LENGTH, givenNameFromIdToken } from "./idToken.js";

function b64url(bytes: Buffer, pad = false): string {
  const s = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return pad ? s : s.replace(/=+$/, "");
}

function token(claims: unknown, pad = false): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256" })));
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"), pad);
  return `${header}.${payload}.sig`;
}

describe("givenNameFromIdToken", () => {
  it("returns given_name", () => {
    expect(givenNameFromIdToken(token({ given_name: "Ruchi", name: "Ruchi A" }))).toBe("Ruchi");
  });

  it("trims given_name", () => {
    expect(givenNameFromIdToken(token({ given_name: "  Ana  " }))).toBe("Ana");
  });

  it("falls back to the first word of name", () => {
    expect(givenNameFromIdToken(token({ name: "  Maria  Garcia " }))).toBe("Maria");
    expect(givenNameFromIdToken(token({ given_name: "  ", name: "Li Wei" }))).toBe("Li");
  });

  it("prefers given_name, then name, over email", () => {
    expect(givenNameFromIdToken(token({ given_name: "Ana", email: "zed@x.com" }))).toBe("Ana");
    expect(givenNameFromIdToken(token({ name: "Li Wei", email: "zed@x.com" }))).toBe("Li");
  });

  it("falls back to the capitalised email local part", () => {
    expect(givenNameFromIdToken(token({ email: "jane.doe@example.com" }))).toBe("Jane");
    expect(givenNameFromIdToken(token({ email: "sam_k+tag@x.com" }))).toBe("Sam");
    expect(givenNameFromIdToken(token({ email: "ana@x.com" }))).toBe("Ana");
    expect(givenNameFromIdToken(token({ email: "@x.com" }))).toBeUndefined();
    expect(givenNameFromIdToken(token({ email: 5 }))).toBeUndefined();
  });

  it("decodes non-ASCII names (2, 3 and 4 byte UTF-8)", () => {
    expect(givenNameFromIdToken(token({ given_name: "José" }))).toBe("José");
    expect(givenNameFromIdToken(token({ given_name: "Zoë" }))).toBe("Zoë");
    expect(givenNameFromIdToken(token({ given_name: "太郎" }))).toBe("太郎");
    expect(givenNameFromIdToken(token({ given_name: "A😀" }))).toBe("A😀");
  });

  it("handles every padding variant and URL-safe characters", () => {
    for (const name of ["a", "ab", "abc", "abcd", "abcde", "José", "Zoë", "???>>>"]) {
      expect(givenNameFromIdToken(token({ given_name: name }, true))).toBe(name);
      expect(givenNameFromIdToken(token({ given_name: name }, false))).toBe(name);
    }
    // Payload containing bytes that map to '-' and '_' in base64url.
    const raw = Buffer.from(JSON.stringify({ given_name: "ÿþ" }), "utf8");
    const enc = b64url(raw);
    expect(`${enc}`).toMatch(/[-_]/);
    expect(givenNameFromIdToken(`h.${enc}.s`)).toBe("ÿþ");
  });

  it("returns undefined when claims are missing or the wrong type", () => {
    expect(givenNameFromIdToken(token({}))).toBeUndefined();
    expect(givenNameFromIdToken(token({ given_name: 5, name: ["x"] }))).toBeUndefined();
    expect(givenNameFromIdToken(token({ given_name: "   ", name: "  " }))).toBeUndefined();
    expect(givenNameFromIdToken(token([1, 2]))).toBeUndefined();
    expect(givenNameFromIdToken(token(null))).toBeUndefined();
  });

  it("returns undefined for garbage without throwing", () => {
    const bad: Array<string | null | undefined> = [
      undefined,
      null,
      "",
      "abc",
      "a.b",
      "a..c",
      "a.!!!!.c",
      "a.e.c",
      `a.${b64url(Buffer.from("not json"))}.c`,
      `a.${b64url(Buffer.from([0xff, 0xfe, 0xfd]))}.c`,
      `a.${b64url(Buffer.from([0xc0, 0x80]))}.c`,
      `a.${b64url(Buffer.from([0xe2, 0x82]))}.c`,
      `a.${b64url(Buffer.from([0xed, 0xa0, 0x80]))}.c`,
    ];
    for (const t of bad) expect(givenNameFromIdToken(t)).toBeUndefined();
    expect(givenNameFromIdToken(123 as unknown as string)).toBeUndefined();
  });

  it("strips control characters", () => {
    expect(givenNameFromIdToken(token({ given_name: "An\u0000\u0007a" }))).toBe("An a");
    expect(givenNameFromIdToken(token({ given_name: "\u0001\u0002" }))).toBeUndefined();
    expect(givenNameFromIdToken(token({ given_name: "Bo\nb" }))).toBe("Bo b");
  });

  it("caps the length without splitting a code point", () => {
    const long = "x".repeat(100);
    expect(givenNameFromIdToken(token({ given_name: long }))).toBe(
      "x".repeat(MAX_GIVEN_NAME_LENGTH),
    );
    const emoji = "😀".repeat(50);
    const out = givenNameFromIdToken(token({ given_name: emoji }))!;
    expect(Array.from(out)).toHaveLength(MAX_GIVEN_NAME_LENGTH);
  });
});
