import { describe, expect, it } from "vitest";
import { elementSpan, sentenceSpan, snapWords } from "./segment";

const bounds = (t: string, pos: number, hard = false): [number, number] => {
  const s = elementSpan(t, pos, hard) ?? sentenceSpan(t, pos, hard);
  return [s.from, s.to];
};

describe("snapWords", () => {
  const t = "for. When the thing goes. Then";
  it("expands to whole words", () => {
    const i = t.indexOf("thing") + 2;
    const s = snapWords(t, i, i + 3);
    expect(t.slice(s.from, s.to)).toBe("thing");
  });
  it("excludes end punctuation when start is preceded by a word", () => {
    const f = t.indexOf("the thing");
    const s = snapWords(t, f + 2, t.indexOf("goes") + 3);
    expect(t.slice(s.from, s.to)).toBe("the thing goes");
  });
  it("includes end punctuation when start is preceded by punctuation", () => {
    const f = t.indexOf("When");
    const s = snapWords(t, f + 1, t.indexOf("goes") + 3);
    expect(t.slice(s.from, s.to)).toBe("When the thing goes.");
  });
  it("treats * as part of a word (trans*)", () => {
    const a = "für trans* Menschen";
    const s = snapWords(a, a.indexOf("trans") + 2, a.indexOf("trans") + 3);
    expect(a.slice(s.from, s.to)).toBe("trans*");
  });
});

describe("elementSpan", () => {
  it("finds the german quote span, delimiters included", () => {
    const t = "Er ruft „Hallo!“ und geht";
    const s = elementSpan(t, t.indexOf("Hallo") + 1);
    expect(s && t.slice(s.from, s.to)).toBe("„Hallo!“");
  });
  it("prefers the innermost pair", () => {
    const t = "(a „b c“ d)";
    const s = elementSpan(t, t.indexOf("c"));
    expect(s && t.slice(s.from, s.to)).toBe("„b c“");
  });
  it("appends trailing punctuation only per the preceded rule", () => {
    const a = 'sagt "Hallo". Ende';
    const s1 = elementSpan(a, a.indexOf("Hallo"));
    expect(s1 && a.slice(s1.from, s1.to)).toBe('"Hallo"');
    const b = 'sagt: "Hallo". Ende';
    const s2 = elementSpan(b, b.indexOf("Hallo"));
    expect(s2 && b.slice(s2.from, s2.to)).toBe('"Hallo".');
  });
  it("ignores intra-word apostrophes", () => {
    expect(elementSpan("l'avvocato è qui", 3)).toBe(null);
  });
  it("ignores positions outside any pair", () => {
    expect(elementSpan("(a) b", 4)).toBe(null);
    expect(elementSpan("offen", 1)).toBe(null);
  });
  it("selects when clicking directly on a delimiter", () => {
    const t = "„Hallo“";
    const s = elementSpan(t, 0);
    expect(s && t.slice(s.from, s.to)).toBe("„Hallo“");
  });
  it("handles single low quotes and guillemets", () => {
    const a = "er sagt \u201Agenau so\u2019 heute";
    const sa = elementSpan(a, a.indexOf("genau"));
    expect(sa && a.slice(sa.from, sa.to)).toBe("\u201Agenau so\u2019");
    const b = "mit \u00ABdruck\u00BB endet";
    const sb = elementSpan(b, b.indexOf("druck"));
    expect(sb && b.slice(sb.from, sb.to)).toBe("\u00ABdruck\u00BB");
  });
  it("demotes quotes around multiple sentences so the clicked sentence wins", () => {
    const t = "„Er kam. Sie ging.“";
    expect(elementSpan(t, t.indexOf("kam"))).toBe(null);
    const s = sentenceSpan(t, t.indexOf("kam"));
    expect(t.slice(s.from, s.to)).toBe("Er kam.");
    const s2 = sentenceSpan(t, t.indexOf("Sie"));
    expect(t.slice(s2.from, s2.to)).toBe("Sie ging.");
  });
  it("keeps quotes atomic when they hold no sentence boundary", () => {
    const t = "„Und so, wirklich, ja“ sagte sie";
    const s = elementSpan(t, t.indexOf("wirklich"));
    expect(s && t.slice(s.from, s.to)).toBe("„Und so, wirklich, ja“");
  });
  it("demotes a quote with two sentences even mid-phrase", () => {
    const t = "\u201EWirklich? Ja!\u201C sagte sie";
    expect(elementSpan(t, t.indexOf("Ja"))).toBe(null);
  });
  it("clicking sentence 1 of a quoted pair excludes the opening quote, keeps its period", () => {
    const t = '"Sentence 1. Sentence 2"';
    const s1 = sentenceSpan(t, t.indexOf("Sentence 1"));
    expect(t.slice(s1.from, s1.to)).toBe("Sentence 1.");
    const s2 = sentenceSpan(t, t.indexOf("Sentence 2"));
    expect(t.slice(s2.from, s2.to)).toBe("Sentence 2\u0022");
  });
  it("never crosses a paragraph break", () => {
    const t = "„offen\n\n geschlossen“";
    expect(elementSpan(t, 1)).toBe(null);
    expect(elementSpan(t, t.indexOf("gesch"))).toBe(null);
  });
});

describe("sentenceSpan", () => {
  const t = "Er kam. Sie ging. Es endete!";
  it("selects the whole middle sentence with terminator per rule", () => {
    const s = sentenceSpan(t, t.indexOf("ging"));
    expect(t.slice(s.from, s.to)).toBe("Sie ging.");
  });
  it("first sentence drops its terminator (start not preceded by punct)", () => {
    const s = sentenceSpan(t, t.indexOf("kam"));
    expect(t.slice(s.from, s.to)).toBe("Er kam");
  });
  it("skips abbreviation periods", () => {
    const a = "Das z. B. macht Sinn.";
    const s = sentenceSpan(a, a.indexOf("macht"));
    expect(a.slice(s.from, s.to)).toBe("Das z. B. macht Sinn");
  });
  it("spans to end of sentence across commas", () => {
    const s = sentenceSpan(t, t.indexOf("endete"));
    expect(t.slice(s.from, s.to)).toBe("Es endete!");
  });
  it("treats a paragraph break as a sentence boundary", () => {
    const m = "Er kam. Sie ging.\n\nEs regnete. Es schneite!";
    expect(m.slice(...bounds(m, m.indexOf("ging")))).toBe("Sie ging.");
    expect(m.slice(...bounds(m, m.indexOf("regnete")))).toBe("Es regnete.");
    expect(m.slice(...bounds(m, m.indexOf("schneite")))).toBe("Es schneite!");
  });

  it("hard mode: every newline is a paragraph boundary (PDF text lines)", () => {
    const t = "Er kam.\nSie ging.\n\nEs regnete.";
    expect(t.slice(...bounds(t, t.indexOf("kam"), true))).toBe("Er kam");
    expect(t.slice(...bounds(t, t.indexOf("ging"), true))).toBe("Sie ging.");
    expect(t.slice(...bounds(t, t.indexOf("regnete"), true))).toBe("Es regnete.");
  });

  it("hard mode: a clicked line never selects across lines", () => {
    const u = "Zeile eins ohne Ende\nZeile zwei auch nicht";
    const s = sentenceSpan(u, 3, true);
    expect(u.slice(s.from, s.to)).toBe("Zeile eins ohne Ende");
  });

  it("hard mode: elementSpan clamps to the line", () => {
    const q = "anfang „Zitat\nende“ schluss";
    const pos = q.indexOf("Zitat");
    expect(elementSpan(q, pos)).not.toBeNull(); // soft mode keeps the cross-line pair
    expect(elementSpan(q, pos, true)).toBeNull(); // hard mode demotes it to the line
  });
  it("a wrapped single line break keeps one flowing sentence", () => {
    const u = "ein langer\ngedankengang endet\nhier";
    // no terminators and no blank lines: the whole run is one sentence
    expect(u.slice(...bounds(u, u.indexOf("langer")))).toBe(u);
    expect(u.slice(...bounds(u, u.indexOf("hier")))).toBe(u);
  });
  it("first sentence of a paragraph keeps its terminator (break counts as punct)", () => {
    const u = "Er kam\n\nDanach ging sie.";
    expect(u.slice(...bounds(u, u.indexOf("kam")))).toBe("Er kam");
    expect(u.slice(...bounds(u, u.indexOf("Danach")))).toBe("Danach ging sie.");
  });
  it("skips blockquote markers and the opening quote at a sentence start", () => {
    const t =
      "> „Besonders problematisch ist die voraussetzungslose Änderung von Geschlecht und Namen bei Kindern und Jugendlichen.";
    expect(t.slice(...bounds(t, t.indexOf("problematisch")))).toBe(
      "Besonders problematisch ist die voraussetzungslose Änderung von Geschlecht und Namen bei Kindern und Jugendlichen.",
    );
  });
  it("excludes a closing quote continued from an earlier paragraph", () => {
    const t =
      "> „Erste Aussage.\n\nWenn sich das Kind, der Jugendliche später mit seinem biologischen Geschlecht ausgesöhnt hätte?“";
    expect(t.slice(...bounds(t, t.indexOf("biologischen")))).toBe(
      "Wenn sich das Kind, der Jugendliche später mit seinem biologischen Geschlecht ausgesöhnt hätte?",
    );
  });
  it("recognizes a sentence starting after a blockquote marker", () => {
    const t = "> Erste Aussage.\n> Wenn sich alles klärt.";
    expect(t.slice(...bounds(t, t.indexOf("klärt")))).toBe("Wenn sich alles klärt.");
  });
  it("keeps an ordinal period inside the sentence when followed by lowercase", () => {
    const t = "Er kam nach dem 6. mal wieder.";
    expect(t.slice(...bounds(t, t.indexOf("wieder")))).toBe("Er kam nach dem 6. mal wieder");
    expect(t.slice(...bounds(t, t.indexOf("dem")))).toBe("Er kam nach dem 6. mal wieder");
  });
  it("splits after an ordinal period when followed by uppercase", () => {
    const t = "Am 6. Januar tagte der Ausschuss.";
    expect(t.slice(...bounds(t, t.indexOf("tagte")))).toBe("Januar tagte der Ausschuss.");
  });
  it("drops a continued quote closer even inside one paragraph", () => {
    const t = "> „Erste Aussage.\nWenn sich alles klärt?“";
    expect(t.slice(...bounds(t, t.indexOf("klärt")))).toBe("Wenn sich alles klärt?");
  });
  it("handles empty and edge inputs", () => {
    expect(sentenceSpan("", 0)).toEqual({ from: 0, to: 0 });
    expect(snapWords("", 0, 0)).toEqual({ from: 0, to: 0 });
    expect(elementSpan("", 0)).toBe(null);
    const t2 = "Satz.";
    expect(t2.slice(...bounds(t2, 0))).toBe("Satz");
  });
  it("returns an empty span when pos sits exactly on a hard break", () => {
    expect(sentenceSpan("\n", 0, true)).toEqual({ from: 0, to: 0 });
    expect(sentenceSpan("a\nb", 1, true)).toEqual({ from: 0, to: 1 });
    expect(sentenceSpan("\n\nx", 0, true)).toEqual({ from: 0, to: 0 });
  });
});

describe("fuzz: span helpers stay in bounds", () => {
  const ALPHA = "aB,.!?\"'’„“«»> \n*123ßäöü-:;()[]";
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * n);
  };
  const texts = Array.from({ length: 300 }, () => {
    const len = 1 + rnd(120);
    let s = "";
    for (let i = 0; i < len; i++) s += ALPHA[rnd(ALPHA.length)];
    return s;
  });

  for (const hard of [false, true]) {
    it(`random texts: sentenceSpan/elementSpan/snapWords never return out-of-bounds spans (hard=${hard})`, () => {
      for (const t of texts) {
        for (let pos = 0; pos <= t.length; pos++) {
          const s = sentenceSpan(t, pos, hard);
          expect(s.from).toBeGreaterThanOrEqual(0);
          expect(s.from).toBeLessThanOrEqual(s.to);
          expect(s.to).toBeLessThanOrEqual(t.length);
          if (hard) expect(t.slice(s.from, s.to)).not.toContain("\n");
          const e = elementSpan(t, pos, hard);
          if (e !== null) {
            expect(e.from).toBeGreaterThanOrEqual(0);
            expect(e.from).toBeLessThan(e.to);
            expect(e.to).toBeLessThanOrEqual(t.length);
            if (hard) expect(t.slice(e.from, e.to)).not.toContain("\n");
          }
        }
        for (let k = 0; k < 20; k++) {
          const a = rnd(t.length + 1);
          const b = rnd(t.length + 1);
          const w = snapWords(t, Math.min(a, b), Math.max(a, b));
          expect(w.from).toBeGreaterThanOrEqual(0);
          expect(w.from).toBeLessThanOrEqual(w.to);
          expect(w.to).toBeLessThanOrEqual(t.length);
        }
      }
    });
  }
});
