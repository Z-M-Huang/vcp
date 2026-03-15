#!/usr/bin/env bun
/**
 * Name Helper — deterministic naming for analysis files and plan variant directories.
 *
 * Avoids fragile inline bun -e snippets in SKILL.md by providing a proper CLI.
 *
 * Usage:
 *   bun name-helper.ts --type analysis   --index 0 --system-prompt planner --provider Bailian --model qwen3.5-plus
 *   bun name-helper.ts --type plan-variant --index 0 --system-prompt planner --provider Bailian --model qwen3.5-plus
 *   bun name-helper.ts --type plan-variants --list --task-dir .vcp/task
 *
 * Output: the computed filename/dirname on stdout.
 */

import fs from 'fs';
import path from 'path';
import { getAnalysisFileName, getPlanVariantDirName } from '../types/stage-definitions.ts';

function usage(): never {
  console.error('Usage: bun name-helper.ts --type <analysis|plan-variant|plan-variants> --index <n> --system-prompt <name> --provider <name> --model <name>');
  console.error('       bun name-helper.ts --type plan-variants --list --task-dir <dir>');
  process.exit(1);
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      result[args[i].slice(2)] = args[i + 1];
      i++;
    } else if (args[i] === '--list') {
      result['list'] = 'true';
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const type = args['type'];

if (!type) usage();

if (type === 'plan-variants' && args['list'] === 'true') {
  // List all plan variant directories in the task dir
  const taskDir = args['task-dir'];
  if (!taskDir) { console.error('--task-dir required with --list'); process.exit(1); }
  const resolved = path.resolve(taskDir);
  if (!fs.existsSync(resolved)) { process.exit(0); }
  const dirs = fs.readdirSync(resolved)
    .filter((f: string) => f.match(/^plan-\d+-/) && fs.statSync(path.join(resolved, f)).isDirectory());
  for (const d of dirs) console.log(d);
  process.exit(0);
}

const index = parseInt(args['index'] ?? '', 10);
const systemPrompt = args['system-prompt'];
const provider = args['provider'];
const model = args['model'];

if (isNaN(index) || !systemPrompt || !provider || !model) usage();

switch (type) {
  case 'analysis':
    console.log(getAnalysisFileName(index, systemPrompt, provider, model));
    break;
  case 'plan-variant':
    console.log(getPlanVariantDirName(index, systemPrompt, provider, model));
    break;
  default:
    console.error(`Unknown type: ${type}`);
    process.exit(1);
}
