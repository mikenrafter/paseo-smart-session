/** Shared model of Paseo v0.8's runtime-entry compiler boundaries. */
import { parse } from "@babel/parser";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export const SDK_SPECIFIERS = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/acp",
];

const CLIENT_SDK_SPECIFIERS = new Set([
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
]);
const SERVER_SDK_SPECIFIERS = new Set([
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/acp",
]);

export const CLIENT_EXTERNALS = [
  "@getpaseo/plugin",
  ...CLIENT_SDK_SPECIFIERS,
  "@tanstack/react-query",
  "react",
  "react/jsx-runtime",
  "react-native",
  "zod",
];

export const SERVER_EXTERNALS = [
  "@getpaseo/plugin",
  ...SERVER_SDK_SPECIFIERS,
  "zod",
];

function sourceFiles(directory) {
  const files = [];
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

function location(file, root) {
  const path = relative(root, file);
  const first = path.split(sep)[0];
  if (first === "client" || /^index\.client\.tsx?$/.test(path)) return "client";
  if (first === "server" || /^index\.server\.tsx?$/.test(path)) return "server";
  if (first === "shared") return "shared";
  return "invalid";
}

function importsOf(file) {
  const ast = parse(readFileSync(file, "utf8"), {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  const imports = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (
      (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      typeof node.source?.value === "string"
    ) {
      imports.push(node.source.value);
    } else if (node.type === "TSImportType" && typeof node.argument?.value === "string") {
      imports.push(node.argument.value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  })(ast.program);
  return imports;
}

function boundaryError(owner, specifier, file, root) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const target = location(resolve(dirname(file), specifier), root);
    if (target === "invalid") return `module is outside client/, server/, or shared/: ${specifier}`;
    if (owner === "shared" && target !== "shared") return `shared code imports ${target}-only module: ${specifier}`;
    if (owner === "client" && target === "server") return `client code imports server-only module: ${specifier}`;
    if (owner === "server" && target === "client") return `server code imports client-only module: ${specifier}`;
    return null;
  }

  if (specifier === "@getpaseo/plugin/client/host") return `imports private host module: ${specifier}`;
  if (
    (specifier === "@getpaseo/plugin" || specifier.startsWith("@getpaseo/plugin/")) &&
    !SDK_SPECIFIERS.includes(specifier)
  ) {
    return `imports unknown SDK module: ${specifier}`;
  }
  if (owner !== "server" && (specifier.startsWith("node:") || isBuiltin(specifier))) {
    return `${owner} code imports Node module: ${specifier}`;
  }
  if (owner !== "client" && CLIENT_SDK_SPECIFIERS.has(specifier)) {
    return `${owner} code imports client SDK module: ${specifier}`;
  }
  if (owner !== "server" && SERVER_SDK_SPECIFIERS.has(specifier)) {
    return `${owner} code imports server SDK module: ${specifier}`;
  }
  if (
    owner !== "client" &&
    /^(react|react-native|use-sync-external-store|@tanstack\/react-query)(\/|$)/.test(specifier)
  ) {
    return `${owner} code imports client runtime module: ${specifier}`;
  }
  return null;
}

export function auditRuntimeBoundaries(root) {
  const files = [
    ...["index.client.ts", "index.client.tsx", "index.server.ts", "index.server.tsx"]
      .map((name) => join(root, name))
      .filter((file) => statSync(file, { throwIfNoEntry: false })?.isFile()),
    ...sourceFiles(join(root, "client")),
    ...sourceFiles(join(root, "server")),
    ...sourceFiles(join(root, "shared")),
  ];
  const failures = [];
  for (const file of files) {
    const owner = location(file, root);
    for (const specifier of importsOf(file)) {
      const error = boundaryError(owner, specifier, file, root);
      if (error !== null) failures.push(`${relative(root, file)}: ${error}`);
    }
  }
  return failures;
}

export function buildOptions(entryPath, root, target) {
  return {
    entryPoints: [entryPath],
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: "cjs",
    platform: target === "server" ? "node" : "neutral",
    target: target === "server" ? "node20" : "es2020",
    supported: target === "client" ? { "async-await": false } : undefined,
    external: target === "client" ? CLIENT_EXTERNALS : SERVER_EXTERNALS,
    logLevel: "silent",
    treeShaking: true,
  };
}

/** Executes a generated CJS bundle with an explicit host-module resolver. */
export function instantiateBundle(code, resolveModule) {
  const directory = mkdtempSync(join(tmpdir(), "smart-session-check-"));
  const file = join(directory, "bundle.cjs");
  writeFileSync(
    file,
    `module.exports=(require)=>{const module={exports:{}};const exports=module.exports;${code};return module.exports;};`,
  );
  try {
    return createRequire(import.meta.url)(file)(resolveModule);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
