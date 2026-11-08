import { codedError } from "./errors";
import { validateDrawingRecord } from "./ipc";

export const assertDrawingJson = (content: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw codedError("Drawing content is not valid JSON", {
      code: "INVALID",
      reason: "invalid-json",
    });
  }
  try {
    validateDrawingRecord(parsed);
  } catch (error) {
    throw codedError(error instanceof Error ? error.message : "Invalid drawing", {
      code: "INVALID",
      reason: "invalid-record",
    });
  }
};
