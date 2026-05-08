#!/usr/bin/env bun
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type PluginVendorMap = Record<string, readonly string[]>;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_ONLY = process.argv.includes("--check");

const PLUGIN_VENDOR_MAP: PluginVendorMap = {
  "plugins/vcp": [
    "config",
    "context-core",
    "logging",
    "llm-runner",
    "prompt-assets",
    "runtime-adapter",
  ],
  "plugins/dev-buddy": [
    "logging",
    "llm-runner",
    "prompt-assets",
  ],
};

const README = `# Vendored @vcp-lib Packages

Generated from repository-root \`lib/*\` packages by:

\`\`\`bash
bun scripts/sync-vcp-lib-vendor.ts
\`\`\`

Do not edit files in this directory by hand. Update the source package under
\`lib/\`, then run the sync script.
`;

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(path);
    }
    if (entry.isFile()) {
      return [path];
    }
    return [];
  }));
  return files.flat().sort();
}

async function packageSourceFiles(packageName: string): Promise<string[]> {
  const root = join(REPO_ROOT, "lib", packageName);
  const src = join(root, "src");
  return [
    join(root, "package.json"),
    ...await listFiles(src),
  ];
}

function destinationFor(pluginRoot: string, packageName: string, sourceFile: string): string {
  const packageRoot = join(REPO_ROOT, "lib", packageName);
  return join(REPO_ROOT, pluginRoot, "vendor", "@vcp-lib", packageName, relative(packageRoot, sourceFile));
}

async function filesEqual(left: string, right: string): Promise<boolean> {
  if (!existsSync(right)) {
    return false;
  }
  const [leftBytes, rightBytes] = await Promise.all([readFile(left), readFile(right)]);
  return leftBytes.equals(rightBytes);
}

async function checkReadme(pluginRoot: string, mismatches: string[]): Promise<void> {
  const readmePath = join(REPO_ROOT, pluginRoot, "vendor", "@vcp-lib", "README.md");
  if (!existsSync(readmePath)) {
    mismatches.push(`${relative(REPO_ROOT, readmePath)} missing`);
    return;
  }
  const actual = await readFile(readmePath, "utf8");
  if (actual !== README) {
    mismatches.push(`${relative(REPO_ROOT, readmePath)} stale`);
  }
}

async function checkPackage(pluginRoot: string, packageName: string, mismatches: string[]): Promise<void> {
  const expectedSources = await packageSourceFiles(packageName);
  const expectedDestinations = new Set(expectedSources.map((source) => destinationFor(pluginRoot, packageName, source)));
  const packageDestRoot = join(REPO_ROOT, pluginRoot, "vendor", "@vcp-lib", packageName);

  if (!existsSync(packageDestRoot)) {
    mismatches.push(`${relative(REPO_ROOT, packageDestRoot)} missing`);
    return;
  }

  for (const source of expectedSources) {
    const dest = destinationFor(pluginRoot, packageName, source);
    if (!await filesEqual(source, dest)) {
      mismatches.push(`${relative(REPO_ROOT, dest)} stale`);
    }
  }

  for (const dest of await listFiles(packageDestRoot)) {
    if (!expectedDestinations.has(dest)) {
      mismatches.push(`${relative(REPO_ROOT, dest)} extra`);
    }
  }
}

async function syncPackage(pluginRoot: string, packageName: string): Promise<void> {
  const packageDestRoot = join(REPO_ROOT, pluginRoot, "vendor", "@vcp-lib", packageName);
  await rm(packageDestRoot, { recursive: true, force: true });

  for (const source of await packageSourceFiles(packageName)) {
    const dest = destinationFor(pluginRoot, packageName, source);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(source, dest);
  }
}

async function syncPlugin(pluginRoot: string, packageNames: readonly string[]): Promise<void> {
  const vendorRoot = join(REPO_ROOT, pluginRoot, "vendor", "@vcp-lib");
  await mkdir(vendorRoot, { recursive: true });
  await writeFile(join(vendorRoot, "README.md"), README);

  const expectedEntries = new Set(["README.md", ...packageNames]);
  for (const entry of existsSync(vendorRoot) ? await readdir(vendorRoot, { withFileTypes: true }) : []) {
    if (!expectedEntries.has(entry.name)) {
      await rm(join(vendorRoot, entry.name), { recursive: true, force: true });
    }
  }

  for (const packageName of packageNames) {
    const sourceRoot = join(REPO_ROOT, "lib", packageName);
    const sourceStat = await stat(sourceRoot);
    if (!sourceStat.isDirectory()) {
      throw new Error(`Missing source package: ${relative(REPO_ROOT, sourceRoot)}`);
    }
    await syncPackage(pluginRoot, packageName);
  }
}

async function checkPlugin(pluginRoot: string, packageNames: readonly string[], mismatches: string[]): Promise<void> {
  const vendorRoot = join(REPO_ROOT, pluginRoot, "vendor", "@vcp-lib");
  const expectedEntries = new Set(["README.md", ...packageNames]);
  if (!existsSync(vendorRoot)) {
    mismatches.push(`${relative(REPO_ROOT, vendorRoot)} missing`);
    return;
  }
  for (const entry of await readdir(vendorRoot, { withFileTypes: true })) {
    if (!expectedEntries.has(entry.name)) {
      mismatches.push(`${relative(REPO_ROOT, join(vendorRoot, entry.name))} extra`);
    }
  }
  await checkReadme(pluginRoot, mismatches);
  for (const packageName of packageNames) {
    await checkPackage(pluginRoot, packageName, mismatches);
  }
}

async function main(): Promise<void> {
  if (CHECK_ONLY) {
    const mismatches: string[] = [];
    for (const [pluginRoot, packageNames] of Object.entries(PLUGIN_VENDOR_MAP)) {
      await checkPlugin(pluginRoot, packageNames, mismatches);
    }
    if (mismatches.length) {
      console.error("Vendored @vcp-lib packages are out of sync:");
      for (const mismatch of mismatches.slice(0, 50)) {
        console.error(`- ${mismatch}`);
      }
      if (mismatches.length > 50) {
        console.error(`...and ${mismatches.length - 50} more`);
      }
      process.exit(1);
    }
    console.log("Vendored @vcp-lib packages are current.");
    return;
  }

  for (const [pluginRoot, packageNames] of Object.entries(PLUGIN_VENDOR_MAP)) {
    await syncPlugin(pluginRoot, packageNames);
  }
  console.log("Synced vendored @vcp-lib packages.");
}

await main();
