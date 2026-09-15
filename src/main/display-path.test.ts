import { resolve, sep } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { formatDisplayPath } from "./display-path";

describe("formatDisplayPath", () => {
  const home = resolve("/home/alex");

  it("does not abbreviate sibling paths sharing the home prefix", () => {
    const path = resolve("/home/alex-other", "drawings");
    expect(formatDisplayPath(path, home)).toBe(path);
  });

  it("leaves the home parent and outside paths unchanged", () => {
    for (const path of [resolve(home, ".."), resolve("/srv/drawings")]) {
      expect(formatDisplayPath(path, home)).toBe(path);
    }
  });

  it("leaves the path unchanged when home is unavailable", () => {
    expect(formatDisplayPath(home, undefined)).toBe(home);
    expect(formatDisplayPath(home, "")).toBe(home);
  });

  it("normalizes dot segments and trailing separators", () => {
    expect(formatDisplayPath(`${home}${sep}Documents${sep}..${sep}drawings`, `${home}${sep}`)).toBe(
      `~${sep}drawings`,
    );
  });

  it("allows descendant names starting with two dots", () => {
    expect(formatDisplayPath(resolve(home, "..drawings"), home)).toBe(`~${sep}..drawings`);
  });

  it("abbreviates the home directory and descendants", () => {
    expect(formatDisplayPath(home, home)).toBe("~");
    expect(formatDisplayPath(resolve(home, "Documents", "Excalidraw"), home)).toBe(
      `~${sep}Documents${sep}Excalidraw`,
    );
  });
});
