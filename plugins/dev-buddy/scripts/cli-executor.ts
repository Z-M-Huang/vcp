#!/usr/bin/env bun
/**
 * Generic CLI Executor — template-based command execution for pipeline reviews.
 *
 * Reads a CLI preset from ~/.vcp/ai-presets.json, substitutes placeholders in the
 * preset's args_template, and executes the resulting command. Supports any CLI tool
 * that can produce structured JSON review output.
 *
 * Placeholders (substituted into args_template / resume_args_template):
 *   {model}            — model name from --model flag (validated against preset.models)
 *   {output_file}      — resolved output file path
 *   {schema_path}      — path to JSON schema for structured output validation
 *   {prompt}           — AI-generated review/task prompt
 *   {reasoning_effort} — reasoning effort level from preset (default: 'medium')
 *
 * Usage:
 *   bun cli-executor.ts --type plan --plugin-root /path/to/plugin --preset codex-cli --model o3
 *   bun cli-executor.ts --type code --plugin-root /path/to/plugin --preset codex-cli --model o4-mini
 *   bun cli-executor.ts --type plan --plugin-root /path/to/plugin --preset codex-cli --model o3 --resume
 *
 * Exit codes:
 *   0 - Success (review completed)
 *   1 - Validation error (missing files, invalid output, missing preset)
 *   2 - CLI execution error (not installed, auth failure)
 *   3 - Timeout
 */

import { spawn, execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readJson as _readJsonBase, fileExists, writeJson } from './pipeline-utils.ts';
import { readPresets, validateCliTemplate, REQUIRED_ARGS_TEMPLATE_PLACEHOLDERS } from './preset-utils.ts';
import type { CliPreset } from '../types/presets.ts';
import { vcpLog, isDebugEnabled } from './vcp-logger.ts';

/** Typed wrapper — cli-executor expects Record<string, unknown> | null */
function readJson(filePath: string): Record<string, unknown> | null {
  return _readJsonBase(filePath) as Record<string, unknown> | null;
}

// ================== CONFIGURATION ==================

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const TASK_DIR = '.vcp/task';
const TRACE_FILE = path.join(TASK_DIR, 'cli_trace.log');

/** Compute the default output file path based on review type.
 *  Fallback for manual/standalone runs only — pipeline always passes --output-file. */
function getDefaultOutputFile(reviewType: string): string {
  return reviewType === 'code'
    ? path.join(TASK_DIR, 'code-review-cli.json')
    : path.join(TASK_DIR, 'plan-review-cli.json');
}

/** Get the resolved output file path: --output-file override if provided, else default.
 *  Logs a warning when falling back to defaults, since pipeline always passes --output-file
 *  and a missing flag usually means a caller bug. */
function getOutputFile(reviewType: string, outputFileOverride: string | null): string {
  if (!outputFileOverride) {
    console.error(`[cli-executor] WARNING: --output-file not provided, falling back to default '${getDefaultOutputFile(reviewType)}'. Pipeline callers should always pass --output-file.`);
  }
  return outputFileOverride ?? getDefaultOutputFile(reviewType);
}

// Session markers are scoped by review type to prevent cross-contamination
function getSessionMarker(reviewType: string): string {
  return path.join(TASK_DIR, `.cli-session-${reviewType}`);
}

// ================== ARGUMENT PARSING ==================

interface ParsedArgs {
  type: string | null;
  pluginRoot: string | null;
  preset: string | null;
  forceResume: boolean;
  changesSummary: string | null;
  outputFile: string | null;
  model: string | null;
}

/** Regex for valid model names — alphanumeric, dots, hyphens, underscores only. */
const MODEL_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const result: ParsedArgs = { type: null, pluginRoot: null, preset: null, forceResume: false, changesSummary: null, outputFile: null, model: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' && args[i + 1]) {
      result.type = args[i + 1];
      i++;
    } else if (args[i] === '--plugin-root' && args[i + 1]) {
      result.pluginRoot = args[i + 1];
      i++;
    } else if (args[i] === '--preset' && args[i + 1]) {
      result.preset = args[i + 1];
      i++;
    } else if (args[i] === '--resume') {
      result.forceResume = true;
    } else if (args[i] === '--changes-summary' && args[i + 1]) {
      result.changesSummary = args[i + 1];
      i++;
    } else if (args[i] === '--output-file' && args[i + 1]) {
      result.outputFile = args[i + 1];
      i++;
    } else if (args[i] === '--model' && args[i + 1]) {
      result.model = args[i + 1];
      i++;
    }
  }

  return result;
}

// ================== PLATFORM DETECTION ==================

function getPlatform(): string {
  const platform = os.platform();
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

function isCommandInstalled(command: string): boolean {
  try {
    execSync(`${command} --version`, { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ================== FILE HELPERS ==================

function writeError(error: string, phase: string, reviewType: string | null, outputFileOverride?: string | null): void {
  const errorData = {
    status: 'error',
    error: error,
    phase: phase,
    timestamp: new Date().toISOString()
  };
  const outputFile = getOutputFile(reviewType || 'plan', outputFileOverride ?? null);
  try {
    writeJson(outputFile, errorData);
  } catch {
    // If the specified output file is invalid (e.g., path traversal blocked by OS),
    // fall back to the default output file.
    try {
      const defaultFile = getDefaultOutputFile(reviewType || 'plan');
      if (defaultFile !== outputFile) {
        writeJson(defaultFile, errorData);
      }
    } catch {
      // Best-effort — error is still reported via stdout JSON
    }
  }
}

// ================== SESSION MANAGEMENT ==================

function hasActiveSession(reviewType: string): boolean {
  return fileExists(getSessionMarker(reviewType));
}

function createSessionMarker(reviewType: string): void {
  try {
    fs.writeFileSync(getSessionMarker(reviewType), new Date().toISOString());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Could not create session marker: ${message}`);
  }
}

function removeSessionMarker(reviewType: string): void {
  try {
    const marker = getSessionMarker(reviewType);
    if (fileExists(marker)) {
      fs.unlinkSync(marker);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Could not remove session marker: ${message}`);
  }
}

// ================== PRESET LOADING ==================

/** Load and validate a CLI preset by name. Returns the preset or throws. */
function loadCliPreset(presetName: string): CliPreset {
  const config = readPresets();
  const preset = config.presets[presetName];
  if (!preset) {
    throw new Error(`Preset '${presetName}' not found in ~/.vcp/ai-presets.json`);
  }
  if (preset.type !== 'cli') {
    throw new Error(`Preset '${presetName}' is type '${preset.type}', expected 'cli'`);
  }
  return preset;
}

// ================== INPUT VALIDATION ==================

function validateInputs(args: ParsedArgs, preset: CliPreset): string[] {
  const errors: string[] = [];

  // Check review type
  if (!args.type || !['plan', 'code'].includes(args.type)) {
    errors.push('Invalid or missing --type (must be "plan" or "code")');
  }

  // Check model is provided and valid
  if (!args.model) {
    errors.push('Missing --model (required for CLI executor)');
  } else if (!MODEL_NAME_REGEX.test(args.model)) {
    errors.push(`Invalid --model value '${args.model}'. Must match /^[a-zA-Z0-9._-]+$/`);
  } else if (!preset.models.includes(args.model)) {
    errors.push(`Model '${args.model}' is not in preset's models list: [${preset.models.join(', ')}]`);
  }

  // Check plugin root
  if (!args.pluginRoot) {
    errors.push('Missing --plugin-root');
  } else if (!fileExists(args.pluginRoot)) {
    errors.push(`Plugin root not found: ${args.pluginRoot}`);
  }

  // Check task directory
  if (!fileExists(TASK_DIR)) {
    errors.push('.vcp/task directory not found');
  }

  // Check review-specific input files (multi-file first, legacy fallback)
  if (args.type === 'plan') {
    if (!fileExists(path.join(TASK_DIR, 'plan', 'manifest.json')) && !fileExists(path.join(TASK_DIR, 'plan-refined.json'))) {
      errors.push('Missing .vcp/task/plan/manifest.json (or legacy plan-refined.json) for plan review');
    }
  } else if (args.type === 'code') {
    if (!fileExists(path.join(TASK_DIR, 'impl-result.json'))) {
      errors.push('Missing .vcp/task/impl-result.json for code review');
    }
  }

  // Check schema files and standards
  if (args.pluginRoot) {
    const schemaFile = args.type === 'plan'
      ? 'plan-review.schema.json'
      : 'review-result.schema.json';
    const schemaPath = path.join(args.pluginRoot, 'docs', 'schemas', schemaFile);
    if (!fileExists(schemaPath)) {
      errors.push(`Missing schema file: ${schemaPath}`);
    }

    const guidelinesPath = path.join(args.pluginRoot, 'docs', 'review-guidelines.md');
    if (!fileExists(guidelinesPath)) {
      errors.push(`Missing review guidelines file: ${guidelinesPath}`);
    }
  }

  // Validate --output-file path traversal (CWE-22)
  if (args.outputFile !== null) {
    if (!args.outputFile.endsWith('.json')) {
      errors.push(`Invalid --output-file '${args.outputFile}': must end in .json`);
    } else {
      const resolvedOutput = path.resolve(args.outputFile);
      const resolvedTaskDir = path.resolve(TASK_DIR);
      const relative = path.relative(resolvedTaskDir, resolvedOutput);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        errors.push(`Invalid --output-file '${args.outputFile}': must resolve under ${TASK_DIR}/ (path traversal blocked)`);
      }
    }
  }

  // Check CLI tool is installed
  if (!isCommandInstalled(preset.command)) {
    errors.push(`CLI tool '${preset.command}' not installed or not in PATH`);
  }

  return errors;
}

// ================== COMMAND BUILDING ==================

interface CmdConfig {
  command: string;
  args: string[];
}

/** Build the review prompt based on review type and context. */
function buildReviewPrompt(args: ParsedArgs, isResume: boolean): string {
  // Multi-file artifact paths with legacy fallback
  const planInput = fileExists('.vcp/task/plan/manifest.json')
    ? '.vcp/task/plan/manifest.json (read manifest, then step files from sections.steps[])'
    : '.vcp/task/plan-refined.json';
  const inputFile = args.type === 'plan' ? planInput : '.vcp/task/impl-result.json';

  const guidelinesPath = path.join(args.pluginRoot!, 'docs', 'review-guidelines.md');

  // AC source: multi-file first, legacy fallback
  const acFile = fileExists('.vcp/task/user-story/acceptance-criteria.json')
    ? '.vcp/task/user-story/acceptance-criteria.json'
    : '.vcp/task/user-story.json';
  const userStoryRef = fileExists(acFile) ? ` Requirements and acceptance criteria are in ${acFile}.` : '';

  const readFilesFirst = `IMPORTANT: You MUST use your shell tools to read ALL referenced files BEFORE producing your review output. Do NOT output the review JSON until you have read and analyzed every file. Read the files first, then produce your final structured review. Also read ${guidelinesPath} for the full review rubric and severity definitions.`;

  if (isResume && args.changesSummary) {
    return `${readFilesFirst}\n\nRe-review after fixes. Changes made:\n${args.changesSummary}\n\nVerify fixes address previous concerns. Check against ${guidelinesPath}.${userStoryRef}`;
  } else if (isResume) {
    return `${readFilesFirst}\n\nRe-review ${inputFile}. Previous concerns should be addressed. Verify against ${guidelinesPath}.${userStoryRef}`;
  } else {
    const criteriaInstruction = args.type === 'plan'
      ? 'Map each acceptance criterion to plan steps.'
      : 'Verify implementation evidence for each acceptance criterion.';
    return `${readFilesFirst}\n\nReview ${inputFile} against ${guidelinesPath}.${userStoryRef} Final gate review for ${args.type === 'plan' ? 'plan approval' : 'code quality'}. ${criteriaInstruction} Only set needs_clarification if you have a genuine question for the user after reading the files — NOT because you have not read them yet.`;
  }
}

/**
 * Tokenize a template string into args, splitting on whitespace but respecting
 * single/double quotes. Returns null on unbalanced quotes.
 */
function tokenizeTemplate(template: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  const len = template.length;
  while (i < len) {
    while (i < len && /\s/.test(template[i])) i++;
    if (i >= len) break;
    let token = '';
    while (i < len && !/\s/.test(template[i])) {
      if (template[i] === '"') {
        i++;
        while (i < len && template[i] !== '"') {
          if (template[i] === '\\' && i + 1 < len) { token += template[i + 1]; i += 2; }
          else { token += template[i]; i++; }
        }
        if (i >= len) return null;
        i++;
      } else if (template[i] === "'") {
        i++;
        while (i < len && template[i] !== "'") { token += template[i]; i++; }
        if (i >= len) return null;
        i++;
      } else { token += template[i]; i++; }
    }
    if (token) tokens.push(token);
  }
  return tokens;
}

/** Substitute placeholders in a template string. */
function substitutePlaceholders(template: string, placeholders: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(placeholders)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

function buildCommand(args: ParsedArgs, preset: CliPreset, isResume: boolean): CmdConfig {
  const schemaFile = args.type === 'plan'
    ? 'plan-review.schema.json'
    : 'review-result.schema.json';
  const schemaPath = path.join(args.pluginRoot!, 'docs', 'schemas', schemaFile);
  const outputFile = getOutputFile(args.type!, args.outputFile);
  const prompt = buildReviewPrompt(args, isResume);

  const placeholders: Record<string, string> = {
    model: args.model!,
    output_file: outputFile,
    schema_path: schemaPath,
    prompt: prompt,
    reasoning_effort: preset.reasoning_effort || 'medium',
  };

  // Choose template: resume if resuming and supported, else standard.
  // Runtime trim guards against whitespace-only values from manual JSON edits.
  const resumeTemplate = preset.resume_args_template?.trim();
  const template = (isResume && preset.supports_resume && resumeTemplate)
    ? resumeTemplate
    : preset.args_template;

  // Runtime placeholder contract check — catches hand-edited presets that bypass validatePreset()
  const templateErr = validateCliTemplate(template, 'args_template', {
    required: REQUIRED_ARGS_TEMPLATE_PLACEHOLDERS,
  });
  if (templateErr) {
    vcpLog(logProjectRoot, { source: 'cli-executor', event: 'template_invalid', decision: 'error', details: templateErr }, debugEnabled);
    throw new Error(`CLI preset has invalid args_template: ${templateErr}`);
  }

  const tokenized = tokenizeTemplate(template);

  if (!tokenized) {
    // Fire-and-forget — best-effort diagnostic logging
    vcpLog(logProjectRoot, { source: 'cli-executor', event: 'tokenize_failed', decision: 'error', details: template }, debugEnabled);
    throw new Error('Failed to tokenize args_template — unbalanced quotes');
  }

  return {
    command: preset.command,
    args: tokenized.map(token => substitutePlaceholders(token, placeholders)),
  };
}

// ================== COMMAND EXECUTION ==================

/**
 * Escape an argument for Windows cmd.exe shell invocation (CWE-78 fix).
 */
function escapeWinArg(arg: string): string {
  const needsQuoting = /[\s\t"&|<>^()@!%]/.test(arg);
  if (!needsQuoting) return arg;

  let escaped = '';
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i];
    if (ch === '"') escaped += '""';
    else if (ch === '%') escaped += '%%';
    else if (ch === '!') escaped += '^!';
    else escaped += ch;
  }
  return `"${escaped}"`;
}

interface RunResult {
  success: boolean;
  error?: string;
  code: number;
  message?: string;
}

function runCommand(cmdConfig: CmdConfig, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const stderrStream = fs.createWriteStream(TRACE_FILE);
    let timedOut = false;

    const isWindows = os.platform() === 'win32';
    let proc: ReturnType<typeof spawn>;

    if (isWindows) {
      const escapedArgs = cmdConfig.args.map(escapeWinArg);
      const fullCommand = `${cmdConfig.command} ${escapedArgs.join(' ')}`;
      proc = spawn(fullCommand, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
      });
    } else {
      proc = spawn(cmdConfig.command, cmdConfig.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });
    }

    proc.stderr!.pipe(stderrStream);

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      stderrStream.end();

      if (timedOut) {
        resolve({ success: false, error: 'timeout', code: 124 });
      } else if (code === 0) {
        resolve({ success: true, code: 0 });
      } else {
        let errorType = 'execution_failed';
        try {
          const stderr = fs.readFileSync(TRACE_FILE, 'utf8');
          if (stderr.includes('stdin is not a terminal') || stderr.includes('not a tty')) {
            errorType = 'stdin_not_terminal';
          } else if (stderr.includes('authentication') || stderr.includes('auth')) {
            errorType = 'auth_required';
          } else if (stderr.includes('not found') || stderr.includes('command not found')) {
            errorType = 'not_installed';
          } else if (stderr.includes('session') || stderr.includes('expired')) {
            errorType = 'session_expired';
          }
        } catch { /* ignore */ }

        resolve({ success: false, error: errorType, code: code ?? 1 });
      }
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeoutId);
      stderrStream.end();

      if (err.code === 'ENOENT') {
        resolve({ success: false, error: 'not_installed', code: 127 });
      } else {
        resolve({ success: false, error: 'spawn_error', code: 1, message: err.message });
      }
    });
  });
}

// ================== OUTPUT VALIDATION ==================

function validateOutput(reviewType: string, outputFileOverride: string | null = null): { valid: boolean; error?: string; output?: Record<string, unknown>; isPlaceholder?: boolean } {
  const outputFile = getOutputFile(reviewType, outputFileOverride);
  if (!fileExists(outputFile)) {
    return { valid: false, error: 'Output file not created' };
  }

  const output = readJson(outputFile);
  if (!output) {
    return { valid: false, error: 'Output is not valid JSON' };
  }

  if (!output.status) {
    return { valid: false, error: 'Output missing "status" field' };
  }

  const validStatuses = ['approved', 'needs_changes', 'needs_clarification', 'rejected'];

  if (!validStatuses.includes(output.status as string)) {
    return { valid: false, error: `Invalid status "${output.status}". Must be one of: ${validStatuses.join(', ')}` };
  }

  if (typeof output.summary !== 'string') {
    return { valid: false, error: 'Output missing "summary" field or summary is not a string' };
  }

  // Detect placeholder reviews where CLI tool output structured JSON without reading files
  if (output.needs_clarification === true) {
    const questions = output.clarification_questions as string[] | undefined;
    if (questions && questions.length > 0) {
      const placeholderPatterns = [
        /^(I'm |I am |Reading |Starting |Collecting |Initializing )/i,
        /read(ing)? .*(file|story|plan|standard|artifact)/i,
        /\bnow\b.*\b(read|review|analyz)/i,
      ];
      const allPlaceholder = questions.every(q =>
        placeholderPatterns.some(p => p.test(q))
      );
      if (allPlaceholder) {
        return { valid: false, isPlaceholder: true, error: 'CLI tool produced a placeholder review without reading files. Will retry.' };
      }
    }
  }

  // For plan reviews, check that requirements_coverage.mapping is not empty
  const coverage = output.requirements_coverage as { mapping?: unknown[]; missing?: unknown[] } | undefined;
  if (coverage && Array.isArray(coverage.mapping) && coverage.mapping.length === 0
      && Array.isArray(coverage.missing) && coverage.missing.length === 0
      && output.status !== 'needs_clarification'
      && output.status !== 'approved') {
    return { valid: false, error: 'Review has empty requirements_coverage mapping with no missing ACs — likely a placeholder response' };
  }

  return { valid: true, output: output };
}

// ================== MAIN ==================

let currentReviewType: string | null = null;
let currentOutputFileOverride: string | null = null;
let debugEnabled = false;
let logProjectRoot = '';

async function main(): Promise<void> {
  const args = parseArgs();
  currentReviewType = args.type;
  currentOutputFileOverride = args.outputFile;
  debugEnabled = await isDebugEnabled();
  logProjectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const platform = getPlatform();

  // Validate preset name is provided
  if (!args.preset) {
    writeError('Missing --preset flag', 'input_validation', args.type, args.outputFile);
    console.log(JSON.stringify({ event: 'error', phase: 'input_validation', errors: ['Missing --preset flag'] }));
    process.exit(1);
  }

  // Load CLI preset
  let preset: CliPreset;
  try {
    preset = loadCliPreset(args.preset);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeError(msg, 'preset_loading', args.type, args.outputFile);
    console.log(JSON.stringify({ event: 'error', phase: 'preset_loading', error: msg }));
    process.exit(1);
  }

  await vcpLog(logProjectRoot, {
    source: 'cli-executor', event: 'preset_loaded', decision: 'info',
    details: `preset=${args.preset} command=${preset.command} reasoning_effort=${preset.reasoning_effort || 'medium'}`,
  }, debugEnabled);

  const timeoutMs = preset.timeout_ms || DEFAULT_TIMEOUT_MS;

  // Determine if this is a resume
  const sessionActive = args.type ? hasActiveSession(args.type) : false;
  const isResume = args.forceResume || (sessionActive && (preset.supports_resume ?? false));

  console.log(JSON.stringify({
    event: 'start',
    type: args.type,
    pluginRoot: args.pluginRoot,
    preset: args.preset,
    command: preset.command,
    platform: platform,
    isResume: isResume,
    sessionActive: sessionActive,
    outputFile: args.outputFile,
    model: args.model,
    timestamp: new Date().toISOString()
  }));

  // Validate inputs
  const validationErrors = validateInputs(args, preset);
  if (validationErrors.length > 0) {
    const errorMsg = validationErrors.join('; ');
    writeError(errorMsg, 'input_validation', args.type, args.outputFile);
    console.log(JSON.stringify({ event: 'error', phase: 'input_validation', errors: validationErrors }));
    process.exit(1);
  }

  // Build and run command
  let cmdConfig: CmdConfig;
  try {
    cmdConfig = buildCommand(args, preset, isResume);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await vcpLog(logProjectRoot, {
      source: 'cli-executor', event: 'command_error', decision: 'error',
      details: msg,
    }, debugEnabled);
    writeError(msg, 'command_building', args.type, args.outputFile);
    console.log(JSON.stringify({ event: 'error', phase: 'command_building', error: msg }));
    process.exit(1);
  }

  const builtPrompt = buildReviewPrompt(args, isResume);
  const truncatedPrompt = builtPrompt.length > 4096 ? builtPrompt.slice(0, 4096) + '…[truncated]' : builtPrompt;
  await vcpLog(logProjectRoot, {
    source: 'cli-executor', event: 'command_built', decision: 'info',
    details: `args=${JSON.stringify(cmdConfig.args)}\n--- PROMPT ---\n${truncatedPrompt}\n--- END PROMPT ---`,
  }, debugEnabled);

  console.log(JSON.stringify({
    event: 'invoking_cli',
    command: cmdConfig.command,
    isResume: isResume,
    timeout_ms: timeoutMs
  }));

  let result = await runCommand(cmdConfig, timeoutMs);

  // Read output file content for verbose logging
  let outputContent = '';
  try {
    const outFile = getOutputFile(args.type!, args.outputFile);
    if (fileExists(outFile)) {
      outputContent = fs.readFileSync(outFile, 'utf8');
    }
  } catch { /* best-effort */ }
  const truncatedOutput = outputContent.length > 4096 ? outputContent.slice(0, 4096) + '…[truncated]' : outputContent;
  await vcpLog(logProjectRoot, {
    source: 'cli-executor', event: 'command_result',
    decision: result.success ? 'info' : 'error',
    details: `success=${result.success} code=${result.code}\n--- OUTPUT ---\n${truncatedOutput}\n--- END OUTPUT ---`,
  }, debugEnabled);

  // Handle session expired - retry without resume
  if (!result.success && result.error === 'session_expired' && isResume) {
    console.log(JSON.stringify({ event: 'session_expired', action: 'retrying_without_resume' }));
    removeSessionMarker(args.type!);
    const freshCmdConfig = buildCommand(args, preset, false);
    result = await runCommand(freshCmdConfig, timeoutMs);
  }

  if (!result.success) {
    let errorMsg: string;
    let exitCode = 2;

    switch (result.error) {
      case 'timeout':
        errorMsg = `CLI review timed out after ${timeoutMs / 1000} seconds`;
        exitCode = 3;
        break;
      case 'auth_required':
        errorMsg = `${preset.command} authentication required`;
        break;
      case 'not_installed':
        errorMsg = `CLI tool '${preset.command}' not installed or not in PATH`;
        break;
      case 'stdin_not_terminal':
        errorMsg = `CLI tool requires a terminal for interactive mode. The executor uses template-based invocation which should not require a TTY.`;
        break;
      case 'session_expired':
        errorMsg = `${preset.command} session expired and retry failed`;
        removeSessionMarker(args.type!);
        break;
      default:
        errorMsg = `CLI execution failed with exit code ${result.code}`;
    }

    writeError(errorMsg, 'cli_execution', args.type, args.outputFile);
    console.log(JSON.stringify({ event: 'error', phase: 'cli_execution', error: result.error, code: result.code, message: errorMsg }));
    process.exit(exitCode);
  }

  // Validate output
  let validation = validateOutput(args.type!, args.outputFile);

  // Retry once if placeholder response detected
  if (!validation.valid && validation.isPlaceholder) {
    console.log(JSON.stringify({ event: 'placeholder_detected', action: 'retrying_fresh', error: validation.error }));
    removeSessionMarker(args.type!);
    const retryCmdConfig = buildCommand(args, preset, false);
    const retryResult = await runCommand(retryCmdConfig, timeoutMs);

    if (retryResult.success) {
      validation = validateOutput(args.type!, args.outputFile);
    } else {
      writeError(`Retry after placeholder also failed (exit ${retryResult.code})`, 'cli_execution', args.type, args.outputFile);
      console.log(JSON.stringify({ event: 'error', phase: 'cli_execution_retry', error: retryResult.error, code: retryResult.code }));
      process.exit(2);
    }
  }

  if (!validation.valid) {
    writeError(validation.error!, 'output_validation', args.type, args.outputFile);
    console.log(JSON.stringify({ event: 'error', phase: 'output_validation', error: validation.error }));
    process.exit(1);
  }

  // Success — stamp output with verification token proving script execution
  const resolvedOutputFile = getOutputFile(args.type!, args.outputFile);
  const verificationToken = crypto.randomUUID();
  validation.output!._codex_verification = {
    token: verificationToken,
    executed_by: 'cli-executor.ts',
    timestamp: new Date().toISOString(),
    pid: process.pid
  };
  writeJson(resolvedOutputFile, validation.output!);

  // Create session marker for future resume
  if (preset.supports_resume) {
    createSessionMarker(args.type!);
  }

  console.log(JSON.stringify({
    event: 'complete',
    status: validation.output!.status,
    summary: validation.output!.summary,
    needs_clarification: validation.output!.needs_clarification || false,
    output_file: resolvedOutputFile,
    session_marker_created: preset.supports_resume ?? false,
    verification_token: verificationToken
  }));

  process.exit(0);
}

main().catch((err: Error) => {
  writeError(err.message, 'unexpected_error', currentReviewType, currentOutputFileOverride);
  console.log(JSON.stringify({ event: 'error', phase: 'unexpected_error', error: err.message }));
  process.exit(1);
});
