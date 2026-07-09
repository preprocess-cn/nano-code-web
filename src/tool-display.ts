/** Tool definition schema (subset of nano-code's ToolDefinition) */
export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
    sideEffect?: boolean;
    timeout?: number;
    displayName?: string;
  };
}

const BIG_FIELDS = new Set([
  'content', 'old_string', 'new_string',
  'fileContent', 'fileContents', 'originalFile', 'replace',
]);

const BUILTIN_DISPLAY_NAMES: Record<string, string> = {
  'run_bash_command': 'Bash',
  'view_file_content': 'Read',
  'write_file_content': 'Write',
  'patch_file': 'Patch',
  'list_project_files': 'List',
  'glob_files': 'Glob',
  'grep_file_content': 'Grep',
};

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Resolve user-friendly tool display name.
 * Priority: tool definition displayName > built-in mapping > agent-xxx > snake_case.
 */
export function getToolDisplayName(toolName: string, definitions?: ToolDef[]): string {
  if (definitions) {
    for (const def of definitions) {
      if (def.function.name === toolName && def.function.displayName) {
        return def.function.displayName;
      }
    }
  }
  if (BUILTIN_DISPLAY_NAMES[toolName]) return BUILTIN_DISPLAY_NAMES[toolName];
  if (toolName.startsWith('agent-')) {
    return toolName.slice(6).split('-').map(capitalize).join(' ');
  }
  return toolName.split('_').map(capitalize).join(' ');
}

/**
 * Build concise args preview for display.
 * Single non-big field → value only; multiple → key=value pairs; big fields skipped.
 */
export function getToolArgsPreview(args: any): string | null {
  if (!args || typeof args !== 'object') return null;

  const truncVal = (v: string, max = 80): string =>
    v.length > max ? v.slice(0, max) + '…' : v;

  const pickKeys = (keys: string[]): string | null => {
    const parts: string[] = [];
    for (const k of keys) {
      const v = args[k];
      if (v !== undefined && v !== null) {
        parts.push(typeof v === 'string' ? truncVal(v) : String(v));
      }
    }
    return parts.length > 0 ? parts.join(', ') : null;
  };

  if (args.pattern) return pickKeys(['pattern', 'path']);
  if (args.glob) return pickKeys(['glob', 'path']);

  if (args.path !== undefined || args.file_path !== undefined) {
    const pathArg = args.path ?? args.file_path;
    const rest: string[] = [];
    for (const k of Object.keys(args)) {
      if (k === 'path' || k === 'file_path' || BIG_FIELDS.has(k)) continue;
      const v = args[k];
      if (typeof v === 'string') rest.push(`${k}=${v}`);
      else rest.push(`${k}=${JSON.stringify(v)}`);
    }
    const pathPart = truncVal(pathArg);
    return rest.length > 0 ? `${pathPart}, ${rest.join(', ')}` : pathPart;
  }

  if (args.content !== undefined) {
    const parts: string[] = [];
    for (const k of Object.keys(args)) {
      if (k === 'content') continue;
      parts.push(`${k}=${typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k])}`);
    }
    return parts.length > 0 ? parts.join(', ') : pickKeys(['content']);
  }

  if (args.command) return truncVal(args.command);
  if (args.url) return pickKeys(['url']);

  const entries: Array<{ key: string; value: string }> = [];
  for (const [k, v] of Object.entries(args)) {
    if (BIG_FIELDS.has(k) || v === undefined || v === null) continue;
    entries.push({ key: k, value: typeof v === 'string' ? truncVal(v) : JSON.stringify(v) });
  }
  if (entries.length === 0) return null;
  if (entries.length === 1) return entries[0].value;
  return entries.map(e => `${e.key}=${e.value}`).join(', ');
}

/**
 * Full formatted tool call string.
 */
export function formatToolCall(toolName: string, args: any, definitions?: ToolDef[]): string {
  const displayName = getToolDisplayName(toolName, definitions);
  if (!args || typeof args !== 'object') return `${displayName}(${JSON.stringify(args)})`;
  if (Object.keys(args).length === 0) return `${displayName}()`;
  const preview = getToolArgsPreview(args);
  if (preview) return `${displayName}(${preview})`;
  const str = JSON.stringify(args);
  return str.length > 200 ? `${displayName}(${str.slice(0, 200)}…)` : `${displayName}(${str})`;
}
