/**
 * Shared pipeline utilities — file helpers used by cli-executor and other scripts.
 */

import fs from 'fs';
import path from 'path';

// ─── File Helpers ───────────────────────────────────────────────────

/** Check if a file exists */
export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** Write JSON data to a file, creating parent directories as needed */
export function writeJson(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Safely read and parse JSON file */
export function readJson(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Check if a JSON file exists and has content */
export function checkJsonExists(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}
