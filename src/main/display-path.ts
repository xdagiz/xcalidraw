import { isAbsolute, relative, resolve, sep } from "node:path";

export const formatDisplayPath = (path: string, home: string | undefined): string => {
  if (!home) return path;

  const relativeToHome = relative(resolve(home), resolve(path));
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!isInsideHome) return path;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
};
