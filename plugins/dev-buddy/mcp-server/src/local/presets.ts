import fs from "fs";
import os from "os";
import path from "path";

export interface ApiPreset {
  type: "api";
  name: string;
  base_url: string;
  api_key: string;
  models: string[];
  timeout_ms?: number;
  protocol?: "anthropic" | "openai";
  reasoning_effort?: "" | "minimal" | "low" | "medium" | "high" | "xhigh";
  max_output_tokens?: number;
  max_context_tokens?: number;
}

export interface SubscriptionPreset {
  type: "subscription";
  name: string;
  timeout_ms?: number;
}

export interface CliPreset {
  type: "cli";
  name: string;
  command: string;
  args_template: string;
  resume_args_template?: string;
  one_shot_args_template?: string;
  supports_resume?: boolean;
  supports_reasoning_effort?: boolean;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh";
  timeout_ms?: number;
  models: string[];
}

export type Preset = ApiPreset | SubscriptionPreset | CliPreset;

export interface PresetConfig {
  version: "2.0";
  presets: Record<string, Preset>;
}

const CONFIG_DIR = path.join(os.homedir(), ".vcp");
const PRESETS_PATH = path.join(CONFIG_DIR, "ai-presets.json");

function createDefaultPresets(): PresetConfig {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {
    // Best-effort on platforms/filesystems that support chmod.
  }

  const config: PresetConfig = {
    version: "2.0",
    presets: {
      "anthropic-subscription": {
        type: "subscription",
        name: "Anthropic Subscription",
      },
    },
  };

  fs.writeFileSync(PRESETS_PATH, JSON.stringify(config, null, 2), "utf-8");
  try {
    fs.chmodSync(PRESETS_PATH, 0o600);
  } catch {
    // Best-effort on platforms/filesystems that support chmod.
  }

  return config;
}

export function readPresets(): PresetConfig {
  if (!fs.existsSync(PRESETS_PATH)) {
    return createDefaultPresets();
  }
  return JSON.parse(fs.readFileSync(PRESETS_PATH, "utf-8")) as PresetConfig;
}

function maskApiKey(key: string): string {
  if (key.length <= 4) return "****";
  return key.slice(0, 3) + "***" + key.slice(-4);
}

export function maskPresetKeys(preset: Preset): Preset {
  if (preset.type === "api") {
    return { ...preset, api_key: maskApiKey(preset.api_key) };
  }
  return preset;
}
