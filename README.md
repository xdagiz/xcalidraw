<p align="center">
  <img width="1280" height="720" alt="image" src="https://github.com/user-attachments/assets/de424488-f72a-41a6-993d-494928face6f" />
</p>

<p align="center">A local-first desktop app for managing your <a href="https://excalidraw.com/">Excalidraw</a> drawings.</p>

<p align="center">
  <a href="https://github.com/xdagiz/xcalidraw/releases"><img src="https://img.shields.io/github/v/release/xdagiz/xcalidraw?style=flat-square&color=000000" alt="Latest release" /></a>
  <a href="https://github.com/xdagiz/xcalidraw/releases"><img src="https://img.shields.io/github/downloads/xdagiz/xcalidraw/total?style=flat-square&color=000000" alt="Total downloads" /></a>
  <a href="https://github.com/xdagiz/xcalidraw/stargazers"><img src="https://img.shields.io/github/stars/xdagiz/xcalidraw?style=flat-square&color=000000" alt="GitHub stars" /></a>
  <a href="https://github.com/xdagiz/xcalidraw/blob/main/LICENSE"><img src="https://img.shields.io/github/license/xdagiz/xcalidraw?style=flat-square&color=000000" alt="License" /></a>
</p>

## Features

- **Local files:** Choose the folder where your `.excalidraw` drawings live.
- **Library management:** Create, rename, and delete drawings and folders.
- **MCP:** Read and edit drawings live over a local server.

## MCP

1. Turn on **Settings → Agents → MCP**. The server runs on `http://127.0.0.1:29180/mcp` while xcalidraw is open.
2. Add it to your agent:

   ```sh
   npx add-mcp http://127.0.0.1:29180/mcp --transport http --name xcalidraw
   ```

3. Then ask your agent to draw!

Agents can list, open and create drawings, add, change and delete elements, and use any [Excalidraw library](https://libraries.excalidraw.com).

## Download

Get the latest Windows, macOS, and Linux builds from [GitHub Releases](https://github.com/xdagiz/xcalidraw/releases).

## Development

### Requirements

- Node.js 24
- [Vite+](https://viteplus.dev/)

## Run locally

```sh
git clone https://github.com/xdagiz/xcalidraw.git
cd xcalidraw
vp install
vpr dev
```

## Acknowledgements

xcalidraw is built with [Excalidraw](https://github.com/excalidraw/excalidraw).
