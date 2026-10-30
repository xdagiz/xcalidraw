import { describe, expect, it, vi } from "vite-plus/test";

import { lanAddress, parseCommand, parseRemoteState } from "./remote";

vi.mock("electron", () => ({ ipcMain: { on: () => undefined } }));
vi.mock("./logger", () => ({ log: {} }));
vi.mock("./window", () => ({}));

const info = (address: string, internal = false) => ({
  address,
  internal,
  family: "IPv4" as const,
  netmask: "",
  mac: "",
  cidr: null,
});

describe("phone remote", () => {
  it("accepts only well-formed slide reports", () => {
    expect(parseRemoteState({ active: false })).toEqual({ active: false });
    const report = { active: true, index: 1, names: ["a", "b"], image: null };
    expect(parseRemoteState(report)).toEqual(report);
    expect(parseRemoteState({ ...report, index: 2 })).toBeNull();
    expect(parseRemoteState({ ...report, image: "javascript:alert(1)" })).toBeNull();
    expect(parseRemoteState({ ...report, names: [1] })).toBeNull();
  });

  it("accepts only next, previous or a slide number from the phone", () => {
    expect(parseCommand("next")).toEqual({ step: "next" });
    expect(parseCommand("3")).toEqual({ index: 3 });
    expect(parseCommand("delete")).toBeNull();
    expect(parseCommand("-1")).toBeNull();
  });

  it("picks a private Wi-Fi address", () => {
    expect(
      lanAddress({
        lo: [info("127.0.0.1", true)],
        docker0: [info("172.17.0.1")],
        wlan0: [info("192.168.1.20")],
      }),
    ).toBe("192.168.1.20");
    expect(lanAddress({ lo: [info("127.0.0.1", true)] })).toBeNull();
  });
});
