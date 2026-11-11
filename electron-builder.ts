import type { Configuration } from "electron-builder";

const artifactName = "${name}-${version}-${os}-${arch}.${ext}";

const config = {
  appId: "com.xcalidraw.app",
  productName: "xcalidraw",
  directories: {
    buildResources: "assets",
  },
  files: [
    "!**/.vscode/*",
    "!src/*",
    "!AGENTS.md",
    "!components.json",
    "!pnpm-workspace.yaml",
    "!scripts/**",
    "!vite.config.{js,ts,mjs,cjs}",
    "!electron.vite.config.{js,ts,mjs,cjs}",
    "!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}",
    "!{.env,.env.*,.npmrc,pnpm-lock.yaml}",
    "!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}",
    "!{.jj,.codex,.pi,.scratch,docs}/**",
  ],
  electronLanguages: ["en-US"],
  fileAssociations: [
    {
      ext: "excalidraw",
      name: "Excalidraw Drawing",
      description: "Excalidraw drawing",
      role: "Editor",
      mimeType: "application/x-excalidraw",
    },
  ],
  win: {
    executableName: "xcalidraw",
    icon: "assets/icon.ico",
  },
  nsis: {
    artifactName,
    shortcutName: "${productName}",
    uninstallDisplayName: "${productName}",
    createDesktopShortcut: "always",
    installerIcon: "assets/icon.ico",
    installerHeaderIcon: "assets/icon.ico",
  },
  mac: {
    icon: "assets/icon.icns",
    target: ["dmg", "zip"],
    artifactName,
    extendInfo: {
      LSMultipleInstancesProhibited: true,
    },
  },
  dmg: {
    artifactName,
  },
  linux: {
    icon: "assets/icon.png",
    target: ["AppImage", "deb", "rpm"],
    maintainer: "xdagiz",
    category: "Utility",
  },
  appImage: {
    artifactName,
  },
  deb: {
    artifactName,
  },
  rpm: {
    artifactName,
  },
  npmRebuild: false,
  publish: {
    provider: "github",
    owner: "xdagiz",
    repo: "xcalidraw",
    channel: "latest",
    releaseType: "draft",
  },
} satisfies Configuration;

export default config;
