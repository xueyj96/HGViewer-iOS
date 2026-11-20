import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Read-only exchange report. CSS remains the sole production source.
const sources = ["src/index.css", "src/ios.css"];
const text = Object.fromEntries(sources.map((path) => [path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8")]));
const declarations = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = text["src/ios.css"].match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]+)\\}`));
  if (!block) throw new Error(`Missing production token block: ${selector}`);
  return Object.fromEntries([...block[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
};
const base = declarations(".plat-ios");
const role = (name) => {
  const expression = base[name];
  if (expression === undefined) throw new Error(`Missing production token: ${name}`);
  const literal = /^(\d+(?:\.\d+)?)px$/.exec(expression);
  return { source: "src/ios.css", variable: name, expression,
    resolution: literal ? "literal" : "requires-browser-computation",
    ...(literal ? { value: Number(literal[1]), unit: "css-px" } : {}) };
};
const mapRoles = (roles) => Object.fromEntries(Object.entries(roles).map(([key, name]) => [key, role(name)]));
console.log(JSON.stringify({
  schemaVersion: 1, application: "HGViewer", status: "source-snapshot-not-runtime-source",
  units: { geometry: "css-px" },
  sourceFiles: sources.map((path) => ({ path, sha256: createHash("sha256").update(text[path]).digest("hex") })),
  coverage: {
    kind: "raw-declarations", selectors: [".plat-ios", "html.theme-light .plat-ios"],
    limits: ["No cascade, media-query, viewport, native safe-area or browser computed-value evaluation",
      "Includes input file hashes, not all component-local CSS or JavaScript animation constants",
      "CSS px and Swift pt are distinct platform units; this report does not assert physical-pixel equivalence"],
  },
  roles: {
    spacing: mapRoles({ sameRowGap: "--ios-control-gap", pageInset: "--ios-header-side-inset", cardInset: "--ios-card-inset", sectionGap: "--ios-section-gap" }),
    control: mapRoles({ standardTargetHeight: "--ios-control-target", outerVisibleHeight: "--ios-control-face", helperVisibleHeight: "--ios-helper-face", outerRadius: "--ios-group-radius", innerRadius: "--ios-control-radius" }),
    typography: mapRoles({ bodySize: "--ios-font-body", bodyLine: "--ios-line-body", titleSize: "--ios-font-title", titleLine: "--ios-line-title", supportingSize: "--ios-font-meta", supportingLine: "--ios-line-meta" }),
    safeArea: mapRoles({ left: "--ios-safe-left", right: "--ios-safe-right", bottomReserve: "--ios-navigation-reserve", bottomClearance: "--ios-navigation-clearance" }),
  },
  rawDeclarations: { base, lightOverrides: declarations("html.theme-light .plat-ios") },
}, null, 2));
