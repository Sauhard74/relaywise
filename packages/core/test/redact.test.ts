import { describe, expect, it } from "vitest";
import { makeRedactor } from "../src/redact.ts";

describe("makeRedactor", () => {
  it("redacts plain secrets and the tokens inside JSON secrets", () => {
    const refresh = "rt_" + "a".repeat(40);
    const redact = makeRedactor(["sk-plain-1234567890", JSON.stringify({ tokens: { refresh_token: refresh }, mode: "chatgpt" })]);
    expect(redact(`key sk-plain-1234567890 and ${refresh}`)).toBe("key [REDACTED] and [REDACTED]");
    expect(redact("chatgpt")).toBe("chatgpt"); // short leaves are not treated as secrets
  });
});
