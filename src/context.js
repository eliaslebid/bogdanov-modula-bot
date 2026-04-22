import { getFileContent } from './github.js';

let projectContext = null;

export async function loadProjectContext() {
  if (projectContext) return projectContext;

  console.log('Loading project context from repo...');
  const [readme, claudeMd] = await Promise.all([
    getFileContent('README.md'),
    getFileContent('CLAUDE.md'),
  ]);

  const parts = [];
  if (claudeMd) {
    parts.push(`=== CLAUDE.md ===\n${claudeMd.slice(0, 4000)}`);
  }
  if (readme) {
    parts.push(`=== README.md ===\n${readme.slice(0, 3000)}`);
  }

  projectContext = parts.join('\n\n') || '(no project docs found)';
  console.log(`Project context loaded: ${projectContext.length} chars`);
  return projectContext;
}

// Refresh every 6 hours
export function startContextRefresh() {
  setInterval(() => {
    projectContext = null;
    loadProjectContext().catch(err => console.error('Context refresh failed:', err));
  }, 6 * 60 * 60 * 1000);
}
