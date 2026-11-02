import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// h19-copy-2: reader copy used to mix the informal "sen" and the formal "siz"
// address, sometimes on the same page. The site's register is "siz" for running
// prose (bare imperatives stay on buttons). This guard reads each converted
// file as text, splits it into whole words with a character scan (no regex
// over JSX) and fails if a removed "sen" form comes back. Whole words, so
// "okuduğunuzu" never trips "okuduğunu" and "deneyin" never trips "dene".
//
// /oyun is the one deliberate exception: the game talks to the player. It is
// not scanned; it must carry the comment that says so.

const ROOT = join(__dirname, "..", "..");

interface Entry {
  /** Repo-relative path. */
  path: string;
  /** Whole words (Turkish-lowercased) that must not appear in the file. */
  banned: readonly string[];
  /** Whole words (Turkish-lowercased) the file must contain: the new "siz" forms. */
  required: readonly string[];
  /** Exact phrases the file must contain, for a form the word list cannot pin down. */
  phrases?: readonly string[];
}

const FILES: readonly Entry[] = [
  {
    path: "src/app/saved/page.tsx",
    banned: ["okuduğunu"],
    required: ["okuduğunuzu"],
  },
  {
    path: "src/app/offline/page.tsx",
    banned: ["çevrimdışısın", "değilsin", "bağlantın", "yenileyebilirsin"],
    required: ["çevrimdışısınız", "değilsiniz", "bağlantınız", "yenileyebilirsiniz"],
  },
  {
    path: "src/app/diyetim/page.tsx",
    banned: ["okuduğunu", "tıkladığın", "diyetin", "kimliğin"],
    required: ["okuduğunuzu", "tıkladığınız", "diyetiniz", "kimliğiniz"],
  },
  {
    path: "src/components/diet/diet-summary.tsx",
    banned: ["tarayıcın", "diyetin", "tıkladığında"],
    required: ["tarayıcınız", "diyetiniz", "tıkladığınızda"],
  },
  {
    path: "src/components/diet/least-read-nudge.tsx",
    banned: ["okuduğun"],
    required: ["okuduğunuz"],
  },
  {
    path: "src/components/bookmark/saved-mix-card.tsx",
    banned: ["diyetin", "kaydettiğin"],
    required: ["diyetiniz", "kaydettiğiniz"],
  },
  {
    path: "src/components/pwa/offline-saved-list.tsx",
    banned: ["kaydettiğinde", "bağlantın"],
    required: ["kaydettiğinizde", "bağlantınız"],
  },
  {
    path: "src/components/newsletter/newsletter-form.tsx",
    banned: ["postana", "dene"],
    required: ["adresinize", "deneyin"],
    phrases: ["Onay bağlantısı e-posta adresinize gönderildi.", "Bir şeyler ters gitti, lütfen tekrar deneyin."],
  },
  {
    path: "src/components/story/share-button.tsx",
    banned: ["sitene"],
    // "sitenize" already sits in the tooltip, so pin the chip label itself.
    required: ["sitenize"],
    phrases: ['"Sitenize ekle"'],
  },
  {
    // h23-a11y-3: #166 missed the clear-data control on /diyetim. The guard reads
    // comments too, so no comment in that file may use the sen forms either.
    path: "src/components/diet/clear-diet-button.tsx",
    banned: ["misin", "verilerin"],
    required: ["misiniz", "verileriniz"],
    phrases: ["Emin misiniz?", "Haber diyeti verileriniz bu cihazdan silindi."],
  },
  {
    // h24 follow-up: the newsletter surfaces still spoke "sen". The button
    // "Evet, aboneliğimi onayla" is first person and stays, so "onayla" is not banned.
    path: "src/app/api/newsletter/confirm/route.ts",
    banned: ["aboneliğini", "musun", "onayladığında"],
    required: ["aboneliğinizi", "musunuz", "onayladığınızda"],
    phrases: [
      "Bülten aboneliğinizi onaylayın — Tayf",
      "Tayf bültenine aboneliğinizi onaylıyor musunuz?",
      "Onayladığınızda haftalık bülteni bu adrese göndermeye başlayacağız.",
    ],
  },
  {
    // The title "Bültenden ayrıl — Tayf" and the button are bare imperatives and stay.
    path: "src/app/api/newsletter/unsubscribe/route.ts",
    banned: ["musun", "onayladığında"],
    required: ["musunuz", "onayladığınızda"],
    phrases: [
      "Tayf bülteninden ayrılmak istiyor musunuz?",
      "Onayladığınızda haftalık bülteni bu adrese bir daha göndermeyiz.",
    ],
  },
  {
    path: "src/app/api/newsletter/route.ts",
    banned: ["kaydolduğun", "kaydını", "tıkla", "sen", "yapmadıysan", "gelebilirsin"],
    required: ["kaydolduğunuz", "kaydınızı", "tıklayın", "siz", "yapmadıysanız", "gelebilirsiniz"],
    phrases: [
      "Tayf haftalık bültenine kaydolduğunuz için teşekkürler.",
      "Kaydınızı onaylamak için buraya tıklayın",
      "Bu isteği siz yapmadıysanız bu e-postayı görmezden gelebilirsiniz.",
      // Both send sites (the existing-subscriber re-send and the fresh signup).
      'subject: "Tayf bültenine kaydınızı onaylayın"',
    ],
  },
  {
    // The footer link "Bültenden çık" is a bare imperative and stays.
    path: "src/lib/digest/template.ts",
    banned: ["kaydolduğun", "alıyorsun"],
    required: ["kaydolduğunuz", "alıyorsunuz"],
    phrases: ["Bu e-postayı Tayf bültenine kaydolduğunuz için alıyorsunuz."],
  },
  {
    // The homepage ?bulten= banner left behind by the confirm/unsubscribe redirects.
    path: "src/lib/newsletter/status.ts",
    banned: ["kaydın", "kutunda", "ayrıldın", "sana"],
    required: ["kaydınız", "kutunuzda", "ayrıldınız", "size"],
    phrases: [
      "Bülten kaydınız onaylandı. Haftalık bülten cumartesi sabahları gelen kutunuzda olacak.",
      "Bültenden ayrıldınız. Size artık bülten göndermeyeceğiz.",
    ],
  },
];

describe("copy register: the newsletter subject at both send sites", () => {
  it("uses the siz subject at exactly two sendEmail call sites", () => {
    const text = readRepoFile("src/app/api/newsletter/route.ts");
    const subject = 'subject: "Tayf bültenine kaydınızı onaylayın"';
    let count = 0;
    let from = 0;
    for (;;) {
      const at = text.indexOf(subject, from);
      if (at === -1) break;
      count += 1;
      from = at + subject.length;
    }
    expect(count).toBe(2);
  });
});

function isLetter(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

/**
 * Whole words of a text: maximal runs of Unicode letters, lowercased with the
 * Turkish rules ("İ" -> "i", "I" -> "ı"). Digits, punctuation, apostrophes,
 * hyphens and JSX syntax are separators, so "okuma-diyetin" is two words.
 */
function wordsOf(text: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const ch of text.normalize("NFC")) {
    if (isLetter(ch)) {
      current += ch;
    } else if (current !== "") {
      words.push(current.toLocaleLowerCase("tr"));
      current = "";
    }
  }
  if (current !== "") words.push(current.toLocaleLowerCase("tr"));
  return words;
}

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("copy-register guard: the word scanner", () => {
  it("splits on punctuation, apostrophes, hyphens and digits", () => {
    expect(wordsOf("Tayf'ta tıkladığın 3 haber; okuma-diyetin")).toEqual([
      "tayf",
      "ta",
      "tıkladığın",
      "haber",
      "okuma",
      "diyetin",
    ]);
  });

  it("lowercases with the Turkish rules", () => {
    expect(wordsOf("ÇEVRİMDIŞISIN Kimliğin İyi")).toEqual(["çevrimdışısın", "kimliğin", "iyi"]);
  });

  it("matches whole words only", () => {
    expect(wordsOf("okuduğunuzu deneyin diyetiniz")).not.toContain("okuduğunu");
    expect(wordsOf("okuduğunuzu deneyin diyetiniz")).not.toContain("dene");
    expect(wordsOf("okuduğunuzu deneyin diyetiniz")).not.toContain("diyetin");
    expect(wordsOf("Haber diyetin yalnızca")).toContain("diyetin");
  });

  it("reads a decomposed letter the same as its composed form", () => {
    const decomposed = "okuduğunu";
    expect(wordsOf(decomposed)).toEqual(["okuduğunu"]);
  });
});

describe("copy-register guard: the lists", () => {
  it("every banned and required word is already in its Turkish-lowercased whole-word form", () => {
    for (const entry of FILES) {
      for (const word of [...entry.banned, ...entry.required]) {
        expect(wordsOf(word)).toEqual([word]);
      }
    }
  });

  it("no word is both banned and required in the same file", () => {
    for (const entry of FILES) {
      for (const word of entry.banned) {
        expect(entry.required).not.toContain(word);
      }
    }
  });
});

describe.each(FILES.map((entry) => [entry.path, entry] as const))("copy register: %s", (_path, entry) => {
  it("exists", () => {
    expect(existsSync(join(ROOT, entry.path))).toBe(true);
  });

  it("contains none of the removed sen forms", () => {
    const words = new Set(wordsOf(readRepoFile(entry.path)));
    const present = entry.banned.filter((word) => words.has(word));
    expect(present).toEqual([]);
  });

  it("contains its siz forms (the guard is not vacuous)", () => {
    const words = new Set(wordsOf(readRepoFile(entry.path)));
    const missing = entry.required.filter((word) => !words.has(word));
    expect(missing).toEqual([]);
  });

  it("contains its exact phrases", () => {
    const text = readRepoFile(entry.path);
    const missing = (entry.phrases ?? []).filter((phrase) => !text.includes(phrase));
    expect(missing).toEqual([]);
  });
});

describe("copy register: the /oyun exception", () => {
  it("is recorded in a comment above the sen-register block", () => {
    const text = readRepoFile("src/app/oyun/page.tsx");
    expect(text.includes("Register exception (h19-copy-2)")).toBe(true);
    // The exception is deliberate: the sen forms it covers are still there.
    const words = new Set(wordsOf(text));
    expect(words.has("okuyabilirsin")).toBe(true);
    expect(words.has("değerlendiriyorsun")).toBe(true);
  });
});
