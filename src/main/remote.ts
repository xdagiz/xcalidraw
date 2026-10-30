import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";

import { REMOTE_COMMAND, REMOTE_INFO, REMOTE_STATE } from "@shared/channels";
import { isRecord } from "@shared/errors";
import type { RemoteCommand, RemoteInfo, RemoteState } from "@shared/ipc";
import { ipcMain } from "electron";

import { log } from "./logger";
import { getMainWindow } from "./window";

const MAX_SLIDES = 500;
const MAX_NAME_LENGTH = 200;
const MAX_IMAGE_LENGTH = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 64;

export const parseRemoteState = (value: unknown): RemoteState | null => {
  if (!isRecord(value)) return null;
  if (value.active === false) return { active: false };
  const { index, names, image } = value;
  if (
    value.active !== true ||
    !Array.isArray(names) ||
    names.length > MAX_SLIDES ||
    !names.every((name) => typeof name === "string" && name.length <= MAX_NAME_LENGTH) ||
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= Math.max(names.length, 1) ||
    !(
      image === null ||
      (typeof image === "string" &&
        image.length <= MAX_IMAGE_LENGTH &&
        image.startsWith("data:image/"))
    )
  ) {
    return null;
  }
  return { active: true, index, names, image };
};

export const parseCommand = (body: string): RemoteCommand | null => {
  if (body === "next" || body === "previous") return { step: body };
  return /^\d{1,3}$/.test(body) ? { index: Number(body) } : null;
};

// The phone reaches the laptop over Wi-Fi, so pick a private LAN address.
export const lanAddress = (interfaces: ReturnType<typeof networkInterfaces>) => {
  const addresses = Object.values(interfaces)
    .flat()
    .filter((info) => info && info.family === "IPv4" && !info.internal)
    .map((info) => info?.address ?? "");
  return (
    addresses.find((address) => /^(192\.168|10)\./.test(address)) ??
    addresses.find((address) => /^172\.(1[6-9]|2\d|3[01])\./.test(address)) ??
    null
  );
};

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>xcalidraw remote</title>
<style>
*{box-sizing:border-box}body{margin:0;font:16px system-ui,sans-serif;background:#f8f9fa;color:#1e1e1e;display:flex;flex-direction:column;min-height:100dvh}
header{padding:16px;font-weight:600}main{flex:1;padding:0 16px;overflow:auto}
#slide{width:100%;aspect-ratio:16/9;object-fit:contain;background:#fff;border:1px solid #dee2e6;border-radius:12px}
#current{margin:12px 0 4px;color:#495057;font-size:14px}h2{font-size:14px;margin:16px 0 8px}
#list{display:flex;flex-direction:column;gap:6px}#list button{text-align:left;padding:10px 12px;border:1px solid #dee2e6;border-radius:8px;background:#fff;font:inherit}
#list button.on{border-color:#6965db;color:#6965db;font-weight:600}
footer{display:flex;justify-content:space-between;align-items:center;padding:16px 24px 28px}
footer button{border:0;border-radius:50%;font-size:28px;cursor:pointer}
#prev{width:64px;height:64px;background:#fff;border:1px solid #dee2e6}#next{width:84px;height:84px;background:#6965db;color:#fff}
#off{display:none;padding:32px 16px;text-align:center;color:#868e96}
</style></head><body>
<header>Presentation remote</header>
<main><img id="slide" alt=""><div id="current"></div><h2>Slides</h2><div id="list"></div><div id="off">The presentation has ended.</div></main>
<footer><button id="prev" aria-label="Previous">&larr;</button><button id="next" aria-label="Next">&rarr;</button></footer>
<script>
const base=location.pathname;
const send=(body)=>fetch(base+"/step",{method:"POST",body});
prev.onclick=()=>send("previous");next.onclick=()=>send("next");
new EventSource(base+"/events").onmessage=(e)=>{
  const s=JSON.parse(e.data);
  off.style.display=s.active?"none":"block";
  if(!s.active)return;
  if(s.image)slide.src=s.image;
  current.textContent="Current slide: "+(s.index+1)+" / "+s.names.length;
  list.replaceChildren(...s.names.map((name,i)=>{const b=document.createElement("button");b.textContent=(i+1)+". "+name;if(i===s.index)b.className="on";b.onclick=()=>send(String(i));return b;}));
};
</script></body></html>`;

let server: Server | null = null;
let starting: Promise<RemoteInfo> | null = null;
let token = "";
let state: RemoteState = { active: false };
const listeners = new Set<ServerResponse>();

const isToken = (candidate: string) => {
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const broadcast = () => {
  const message = `data: ${JSON.stringify(state)}\n\n`;
  for (const response of listeners) response.write(message);
};

const readBody = (req: IncomingMessage) =>
  new Promise<string | null>((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(null));
  });

const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
  const [, secret = "", action = ""] = (req.url ?? "").split("?")[0].split("/");
  if (!token || !isToken(secret)) {
    res.writeHead(404).end();
    return;
  }
  if (req.method === "GET" && action === "") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  } else if (req.method === "GET" && action === "events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    listeners.add(res);
    req.on("close", () => listeners.delete(res));
  } else if (req.method === "POST" && action === "step") {
    const command = parseCommand((await readBody(req)) ?? "");
    if (command) getMainWindow()?.webContents.send(REMOTE_COMMAND, command);
    res.writeHead(command ? 204 : 400).end();
  } else {
    res.writeHead(404).end();
  }
};

const start = () =>
  new Promise<RemoteInfo>((resolve) => {
    const address = lanAddress(networkInterfaces());
    if (!address) {
      resolve({ error: "Connect to Wi-Fi to use your phone as a remote." });
      return;
    }
    token = randomBytes(18).toString("base64url");
    const http = createServer((req, res) => void handleRequest(req, res));
    http.once("error", (error) => {
      log.error("Remote control server failed", error);
      resolve({ error: "Couldn't start the phone remote." });
    });
    // Any free port; the link carries it.
    http.listen(0, "0.0.0.0", () => {
      server = http;
      const bound = http.address();
      const port = typeof bound === "object" && bound ? bound.port : 0;
      resolve({ url: `http://${address}:${port}/${token}` });
    });
  });

const stop = () => {
  for (const response of listeners) response.end();
  listeners.clear();
  server?.close();
  server = null;
  token = "";
};

// The window reports slides while presenting with the remote on; the first report starts the server.
ipcMain.on(REMOTE_STATE, (event, value: unknown) => {
  if (event.sender !== getMainWindow()?.webContents) return;
  const next = parseRemoteState(value);
  if (!next) return;
  state = next;
  if (!next.active) {
    broadcast();
    stop();
    return;
  }
  if (server || starting) {
    broadcast();
    return;
  }
  starting = start();
  void starting.then((info) => {
    starting = null;
    // The presentation may have ended while the server was starting.
    if (!state.active) stop();
    else event.sender.send(REMOTE_INFO, info);
  });
});
