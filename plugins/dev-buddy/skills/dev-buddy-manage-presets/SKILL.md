---
name: dev-buddy-manage-presets
description: Dev Buddy AI provider presets management (list, add, update, remove)
user-invocable: true
allowed-tools: Read, Bash, AskUserQuestion
---

# Manage AI Provider Presets

Manage the AI provider presets stored at `~/.vcp/ai-presets.json`. Presets configure which AI providers are used for each pipeline stage in dev-buddy.

## Supported Operations

### List Presets

Read and display all configured presets. Provider credentials are shown masked (last 4 characters only).

```bash
bun -e "
const { readPresets, maskPresetKeys } = await import('${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts');
const config = readPresets();
for (const [name, preset] of Object.entries(config.presets)) {
  const masked = maskPresetKeys(preset);
  console.log(JSON.stringify({ name, ...masked }, null, 2));
}
"
```

### Add a Preset

Add a new preset by name. The type determines which fields are required:

- **api**: `base_url`, `api_key` (provider credential), `models` (array) are required
- **subscription**: Only `name` is required (uses Task tool)
- **cli**: `command`, `args_template` (must contain `{model}`, `{prompt}`, `{output_file}`), and `models` are required. Optional: `one_shot_args_template` (for `/dev-buddy-once`, must contain `{model}` and `{prompt}`)

Example — add an API preset. Replace `YOUR_PROVIDER_KEY` with your actual credential:
```bash
bun -e "
const { readPresets, writePresets, validatePreset } = await import('${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts');
const config = readPresets();
const newPreset = {
  type: 'api',
  name: 'OpenRouter',
  description: 'OpenRouter API gateway',
  base_url: 'https://openrouter.ai/api/v1',
  api_key: process.env.OPENROUTER_KEY || 'YOUR_PROVIDER_KEY',
  models: ['anthropic/claude-sonnet-4-5', 'anthropic/claude-opus-4']
};
validatePreset(newPreset);
config.presets['openrouter'] = newPreset;
writePresets(config);
console.log('Preset added: openrouter');
"
```

Example — add a subscription preset:
```bash
bun -e "
const { readPresets, writePresets } = await import('${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts');
const config = readPresets();
config.presets['my-subscription'] = { type: 'subscription', name: 'My Claude Subscription' };
writePresets(config);
console.log('Preset added: my-subscription');
"
```

Example — add a CLI preset:
```bash
bun -e "
const { readPresets, writePresets, validatePreset } = await import('${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts');
const config = readPresets();
const newPreset = {
  type: 'cli',
  name: 'OpenAI Codex CLI',
  command: 'codex',
  args_template: 'exec --full-auto -m {model} -o {output_file} --output-schema {schema_path} \"{prompt}\"',
  one_shot_args_template: 'exec --full-auto -m {model} \"{prompt}\"',
  models: ['o3', 'o4-mini']
};
validatePreset(newPreset);
config.presets['codex-cli'] = newPreset;
writePresets(config);
console.log('Preset added: codex-cli');
"
```

### Update a Preset

Modify fields on an existing preset. Always reads first, merges, then writes.

```bash
bun -e "
const { readPresets, writePresets, validatePreset } = await import('${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts');
const config = readPresets();
const presetName = 'openrouter';
if (!config.presets[presetName]) {
  console.error('Preset not found: ' + presetName);
  process.exit(1);
}
config.presets[presetName] = { ...config.presets[presetName], description: 'Updated description' };
validatePreset(config.presets[presetName]);
writePresets(config);
console.log('Preset updated: ' + presetName);
"
```

### Remove a Preset

Delete a preset by name. Before removing, check if it is referenced in the pipeline config.

```bash
bun -e "
import { readPresets, writePresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';
import fs from 'fs';
import os from 'os';
import path from 'path';

const presetName = 'openrouter';

// Check format: feature_pipeline and bugfix_pipeline are arrays of {type, provider, model}
const pipelineConfigPath = path.join(os.homedir(), '.vcp', 'dev-buddy.json');
if (fs.existsSync(pipelineConfigPath)) {
  const pipelineConfig = JSON.parse(fs.readFileSync(pipelineConfigPath, 'utf-8'));
  const usedIn: string[] = [];
  const featurePipeline = pipelineConfig?.feature_pipeline || [];
  featurePipeline.forEach((stage: any, i: number) => {
    if (stage?.provider === presetName) usedIn.push('feature_pipeline[' + i + '] (' + stage.type + ')');
  });
  const bugfixPipeline = pipelineConfig?.bugfix_pipeline || [];
  bugfixPipeline.forEach((stage: any, i: number) => {
    if (stage?.provider === presetName) usedIn.push('bugfix_pipeline[' + i + '] (' + stage.type + ')');
  });
  if (usedIn.length > 0) {
    console.warn('WARNING: Preset is referenced in pipeline stages: ' + usedIn.join(', '));
    console.warn('Update the pipeline config before removing this preset.');
  }
}

const config = readPresets();
if (!config.presets[presetName]) {
  console.error('Preset not found: ' + presetName);
  process.exit(1);
}
delete config.presets[presetName];
writePresets(config);
console.log('Preset removed: ' + presetName);
"
```

## Preset Types

| Type | Required Fields | Usage |
|------|----------------|-------|
| `subscription` | `type`, `name` | Uses Claude Task tool (default) |
| `api` | `type`, `name`, `base_url`, `api_key`, `models` | Direct API provider |
| `cli` | `type`, `name`, `command`, `args_template`, `models` | CLI tool like Codex CLI. Optional: `one_shot_args_template` for `/dev-buddy-once` |

## Config Location

Presets are stored at: `~/.vcp/ai-presets.json`

On first run, a default `anthropic-subscription` preset is automatically created.

## Security Notes

- Provider credentials are masked in all log output and web portal display (showing only the last 4 characters).
- Use the web portal (`/dev-buddy:config`) for a visual interface with secure credential reveal functionality.
- Prefer providing credentials via environment variables (e.g., `process.env.OPENROUTER_KEY`) rather than hardcoding them.
