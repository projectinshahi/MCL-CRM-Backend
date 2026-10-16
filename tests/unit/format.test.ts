import { describe, expect, it } from "vitest";
import { followUpStatus, initials, leadLabel, parseDateOnly, todayIST, toMoney } from "../../src/lib/format.ts";

describe("todayIST", () => {
  it("rolls over at midnight in India, not UTC", () => {
    expect(todayIST(new Date("2026-10-13T18:29:59Z"))).toBe("2026-10-13");
    expect(todayIST(new Date("2026-10-13T18:30:00Z"))).toBe("2026-10-14"); // 00:00 IST
  });
});

describe("followUpStatus", () => {
  const due = parseDateOnly("2026-10-14");
  it("is overdue only when pending and due before today", () => {
    expect(followUpStatus("pending", due, "2026-10-15")).toBe("overdue");
    expect(followUpStatus("pending", due, "2026-10-14")).toBe("pending"); // due today is not overdue
    expect(followUpStatus("pending", due, "2026-10-13")).toBe("pending");
    expect(followUpStatus("completed", due, "2026-12-31")).toBe("completed");
  });
});

describe("toMoney", () => {
  it("keeps paise exactly and passes null through", () => {
    expect(toMoney({ toFixed: () => "249000.55" })).toBe(249000.55);
    expect(toMoney({ toFixed: () => "0.10" })).toBe(0.1);
    expect(toMoney(null)).toBeNull();
  });
});

describe("labels", () => {
  it("builds initials and lead labels", () => {
    expect(initials("aravind  nair kumar")).toBe("AN");
    expect(leadLabel({ title: "Lead", companyName: "MediShip", contactName: "Ribeesh" })).toBe("MediShip - Ribeesh");
    expect(leadLabel({ title: "Lead", companyName: null, contactName: null })).toBe("Lead");
  });
});
