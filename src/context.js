import { getFileContent } from './github.js';

let projectContext = null;

// Never throws. A transient GitHub fetch failure (e.g. DNS blip) at startup
// must not kill the bot — we fall back to an empty-context placeholder and let
// the next refresh tick try again.
export async function loadProjectContext() {
  if (projectContext) return projectContext;

  console.log('Loading project context from repo...');
  let readme = null;
  let claudeMd = null;
  try {
    [readme, claudeMd] = await Promise.all([
      getFileContent('README.md').catch(() => null),
      getFileContent('CLAUDE.md').catch(() => null),
    ]);
  } catch (err) {
    console.warn(`Project context fetch failed (will retry on next refresh): ${err.message}`);
  }

  const parts = [];
  if (claudeMd) parts.push(`=== CLAUDE.md ===\n${claudeMd.slice(0, 4000)}`);
  if (readme) parts.push(`=== README.md ===\n${readme.slice(0, 3000)}`);

  // Cache only when we got something — empty result stays uncached so the next
  // call retries instead of serving a permanent "(no project docs found)".
  const result = parts.join('\n\n');
  if (result) {
    projectContext = result;
    console.log(`Project context loaded: ${projectContext.length} chars`);
    return projectContext;
  }
  console.log('Project context empty — proceeding without it, will retry on next refresh');
  return '(no project docs found)';
}

// Refresh every 6 hours
export function startContextRefresh() {
  setInterval(() => {
    projectContext = null;
    loadProjectContext().catch(err => console.error('Context refresh failed:', err));
  }, 6 * 60 * 60 * 1000);
}
