/**
 * VCP Config Types — schema for project-level .vcp/config.json.
 *
 * Lives in @vcp-lib/config because both global-config and context-core depend
 * on the project config schema. Putting it here breaks the circular type
 * import that existed in the v0.5.x layout.
 */

export interface VcpConfig {
  version: string;
  scopes: Record<string, boolean>;
  compliance: string[];
  ignore?: string[];
  frameworks?: string[];
  exclude?: string[];
  severity?: string;
  pluginRoot?: string;
  standards_url?: string;
}
