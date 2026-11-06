import { describe, it, expect } from "vitest";
import { wordDiff } from "../lib/word-diff";

describe("wordDiff", () => {
  it("marks words the draft lost and the reply added, ignoring case and punctuation", () => {
    const parts = wordDiff("Hi Ellen, I just sent that quote.", "Hi Richard and Ellen, I just sent the quote!");
    const text = (t: string) => parts.filter((p) => p.t === t).map((p) => p.s.trim()).filter(Boolean);
    expect(text("del")).toEqual(["that"]);
    expect(text("ins")).toEqual(["Richard and", "the"]);
    expect(parts.filter((p) => p.t !== "ins").map((p) => p.a ?? p.s).join("")).toBe("Hi Ellen, I just sent that quote.");
  });

  it("identical text is all same", () => {
    expect(wordDiff("a b c", "a b c")).toEqual([{ t: "same", s: "a b c", a: "a b c" }]);
  });
});
