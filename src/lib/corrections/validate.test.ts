import { describe, it, expect } from "vitest";

import {
  correctionFieldMessage,
  isCorrectionField,
  validateCorrection,
  type CorrectionValidation,
} from "./validate";

// The one rule set shared by POST /api/corrections (authoritative) and the
// correction form (which runs it before fetch so a typo never spends the
// 5-token limiter). The rules are the route's, moved unchanged.

const GOOD = {
  url: "https://www.tayfhaber.com/cluster/abc",
  message: "Bu başlık yanlış bilgi içeriyor, lütfen düzeltin.",
  email: "ali@gmail.com",
  clusterId: "0b7f3c52-9a4e-4d1e-8c3a-5f6a7b8c9d0e",
};

function failure(result: CorrectionValidation) {
  if (result.ok) throw new Error("expected a validation failure");
  return result;
}

describe("validateCorrection -- happy path", () => {
  it("accepts a full submission and returns the trimmed value", () => {
    const result = validateCorrection({
      url: `  ${GOOD.url}  `,
      message: `  ${GOOD.message}\n`,
      email: ` ${GOOD.email} `,
      clusterId: ` ${GOOD.clusterId} `,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        url: GOOD.url,
        message: GOOD.message,
        email: GOOD.email,
        clusterId: GOOD.clusterId,
      },
    });
  });

  it("treats an empty, blank, missing or non-string email as no e-mail (null)", () => {
    for (const email of ["", "   ", undefined, null, 42, {}]) {
      const result = validateCorrection({ ...GOOD, email });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.email).toBeNull();
    }
  });

  it("treats an empty, blank, missing or non-string clusterId as no cluster (null)", () => {
    for (const clusterId of ["", "   ", undefined, null, 42]) {
      const result = validateCorrection({ ...GOOD, clusterId });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.clusterId).toBeNull();
    }
  });

  it("accepts an upper-case UUID", () => {
    expect(
      validateCorrection({ ...GOOD, clusterId: GOOD.clusterId.toUpperCase() }).ok,
    ).toBe(true);
  });
});

describe("validateCorrection -- email", () => {
  it("rejects an address without a top-level domain ('ali@gmail')", () => {
    const result = failure(validateCorrection({ ...GOOD, email: "ali@gmail" }));
    expect(result.field).toBe("email");
    expect(result.reason).toBe("Invalid email address");
  });

  it("accepts 'ali@gmail.com'", () => {
    expect(validateCorrection({ ...GOOD, email: "ali@gmail.com" }).ok).toBe(true);
  });

  it.each(["not-an-email", "ali@", "@gmail.com", "ali@gmail.", "a li@gmail.com", "a@b@c.com"])(
    "rejects %j",
    (email) => {
      expect(failure(validateCorrection({ ...GOOD, email })).field).toBe("email");
    },
  );

  it("allows 254 characters and rejects 255", () => {
    const at254 = `${"a".repeat(248)}@x.com`;
    expect(at254).toHaveLength(254);
    expect(validateCorrection({ ...GOOD, email: at254 }).ok).toBe(true);
    const at255 = `${"a".repeat(249)}@x.com`;
    expect(failure(validateCorrection({ ...GOOD, email: at255 })).field).toBe("email");
  });
});

describe("validateCorrection -- url", () => {
  it.each(["ftp://tayfhaber.com/x", "javascript:alert(1)", "data:text/html,hi", "not-a-url", "//tayfhaber.com", ""])(
    "rejects %j",
    (url) => {
      const result = failure(validateCorrection({ ...GOOD, url }));
      expect(result.field).toBe("url");
      expect(result.reason).toBe("Invalid url");
    },
  );

  it("accepts http and https, trimmed", () => {
    expect(validateCorrection({ ...GOOD, url: "http://tayfhaber.com/x" }).ok).toBe(true);
    const padded = validateCorrection({ ...GOOD, url: "  https://tayfhaber.com/x " });
    expect(padded.ok && padded.value.url).toBe("https://tayfhaber.com/x");
  });

  it("allows 512 characters and rejects 513", () => {
    const base = "https://example.com/";
    const at512 = base + "a".repeat(512 - base.length);
    expect(at512).toHaveLength(512);
    expect(validateCorrection({ ...GOOD, url: at512 }).ok).toBe(true);
    expect(failure(validateCorrection({ ...GOOD, url: `${at512}a` })).field).toBe("url");
  });

  it("rejects a missing or non-string url", () => {
    expect(failure(validateCorrection({ ...GOOD, url: undefined })).field).toBe("url");
    expect(failure(validateCorrection({ ...GOOD, url: null })).field).toBe("url");
    expect(failure(validateCorrection({ ...GOOD, url: 123 })).field).toBe("url");
  });
});

describe("validateCorrection -- message", () => {
  it("counts the TRIMMED length: nine spaces and an 'x' is too short", () => {
    const result = failure(validateCorrection({ ...GOOD, message: "         x" }));
    expect(result.field).toBe("message");
    expect(result.reason).toBe("Message must be between 10 and 2000 characters");
  });

  it("allows 10 trimmed characters and rejects 9", () => {
    expect(validateCorrection({ ...GOOD, message: "  abcdefghij  " }).ok).toBe(true);
    expect(failure(validateCorrection({ ...GOOD, message: "  abcdefghi  " })).field).toBe(
      "message",
    );
  });

  it("allows 2000 characters and rejects 2001", () => {
    expect(validateCorrection({ ...GOOD, message: "a".repeat(2000) }).ok).toBe(true);
    expect(failure(validateCorrection({ ...GOOD, message: "a".repeat(2001) })).field).toBe(
      "message",
    );
  });

  it("rejects a missing, empty or non-string message", () => {
    for (const message of [undefined, null, "", "   ", 123, {}]) {
      expect(failure(validateCorrection({ ...GOOD, message })).field).toBe("message");
    }
  });
});

describe("validateCorrection -- clusterId", () => {
  it.each(["not-a-uuid", "0b7f3c52-9a4e-4d1e-8c3a-5f6a7b8c9d0", "0b7f3c52-9a4e-4d1e-8c3a-5f6a7b8c9d0eX", "../x"])(
    "rejects %j",
    (clusterId) => {
      const result = failure(validateCorrection({ ...GOOD, clusterId }));
      expect(result.field).toBe("clusterId");
      expect(result.reason).toBe("Invalid clusterId");
    },
  );
});

describe("validateCorrection -- which field is named first", () => {
  it("reports url before message before email before clusterId, like the route always did", () => {
    const all = { url: "ftp://x", message: "x", email: "ali@gmail", clusterId: "nope" };
    expect(failure(validateCorrection(all)).field).toBe("url");
    expect(failure(validateCorrection({ ...all, url: GOOD.url })).field).toBe("message");
    expect(
      failure(validateCorrection({ ...all, url: GOOD.url, message: GOOD.message })).field,
    ).toBe("email");
    expect(
      failure(
        validateCorrection({ ...all, url: GOOD.url, message: GOOD.message, email: "" }),
      ).field,
    ).toBe("clusterId");
  });

  it("never throws on hostile input", () => {
    const inputs: unknown[] = [undefined, null, 0, "", {}, [], Symbol.iterator.toString()];
    for (const v of inputs) {
      expect(() =>
        validateCorrection({ url: v, message: v, email: v, clusterId: v }),
      ).not.toThrow();
    }
  });
});

describe("isCorrectionField -- reading details.field off a server 400", () => {
  it("accepts exactly the four validated fields", () => {
    for (const f of ["url", "message", "email", "clusterId"]) {
      expect(isCorrectionField(f)).toBe(true);
      expect(correctionFieldMessage(f as "url").length).toBeGreaterThan(0);
    }
  });

  it("rejects anything else, including prototype keys and the honeypot", () => {
    for (const f of ["website", "Email", "", "__proto__", "constructor", "toString", 1, null, undefined, {}, []]) {
      expect(isCorrectionField(f)).toBe(false);
    }
  });
});
