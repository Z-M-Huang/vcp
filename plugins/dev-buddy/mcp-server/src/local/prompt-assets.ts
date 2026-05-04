import fs from "fs";
import path from "path";

export interface StagePrompt {
  stage: string;
  description: string;
  tools: string[];
  disallowedTools?: string[];
  content: string;
  filePath: string;
}

function parseCommaSeparated(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
  if (!raw.startsWith("---")) return null;

  const endIndex = raw.indexOf("\n---", 3);
  if (endIndex === -1) return null;

  const yamlBlock = raw.slice(4, endIndex).trim();
  const body = raw.slice(endIndex + 4).trim();
  const meta: Record<string, string> = {};

  for (const line of yamlBlock.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key && value) {
      meta[key] = value;
    }
  }

  return { meta, body };
}

export function loadStageDefinition(stageType: string, stagesDir: string): StagePrompt | null {
  const filePath = path.join(stagesDir, `${stageType}.md`);
  if (!fs.existsSync(filePath)) return null;

  const parsed = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
  if (!parsed) return null;

  const { meta, body } = parsed;
  if (!meta.stage || meta.stage !== stageType) return null;
  if (!meta.description) return null;
  if (!meta.tools) return null;

  return {
    stage: meta.stage,
    description: meta.description,
    tools: parseCommaSeparated(meta.tools),
    disallowedTools: meta.disallowedTools ? parseCommaSeparated(meta.disallowedTools) : undefined,
    content: body,
    filePath,
  };
}
