import { describe, expect, it } from 'vitest';
import { buildRepoFiles, slugify } from '@/lib/deploy/repo-files';

/**
 * A push or download has to produce a repository that builds — a folder of
 * components with no package.json is not deployable, which is exactly what
 * shipping only the generated files would give you.
 */
describe('buildRepoFiles', () => {
  it('lays the stack scaffold under the generated files', () => {
    const files = buildRepoFiles('REACT', {
      'src/App.tsx': 'export default function App() { return null; }',
    });
    expect(files['src/App.tsx']).toContain('export default function App');
    expect(files['package.json']).toContain('"vite"');
    expect(files['vite.config.js']).toContain('@vitejs/plugin-react');
    expect(files['index.html']).toContain('src/main.tsx');
  });

  it('lets a generated file replace its scaffold counterpart', () => {
    const files = buildRepoFiles('REACT', { 'src/index.css': '/* mine */' });
    expect(files['src/index.css']).toBe('/* mine */');
  });

  it('ships a Dockerfile per stack so Coolify needs no configuration', () => {
    const next = buildRepoFiles('NEXTJS', {})['Dockerfile'];
    expect(next).toContain('CMD ["npm", "start"]');
    expect(next).toContain('EXPOSE 3000');
    // A Vite SPA builds to static files and is served by nginx.
    const react = buildRepoFiles('REACT', {})['Dockerfile'];
    expect(react).toContain('/app/dist');
    expect(react).toContain('try_files');
    expect(buildRepoFiles('STATIC_HTML', {})['Dockerfile']).toContain('nginx');
  });

  it('always includes the housekeeping files a repo needs', () => {
    const files = buildRepoFiles('NEXTJS', {});
    expect(files['.gitignore']).toContain('node_modules');
    expect(files['.dockerignore']).toContain('node_modules');
    expect(files['README.md']).toContain('Coolify');
  });

  it('names the package after the project', () => {
    const files = buildRepoFiles('REACT', {}, { projectName: 'Ember & Oak Coffee' });
    expect(JSON.parse(files['package.json']).name).toBe('ember-oak-coffee');
  });

  it('keeps a generated README rather than overwriting it', () => {
    const files = buildRepoFiles('REACT', { 'README.md': '# Mine' });
    expect(files['README.md']).toBe('# Mine');
  });

  it('slugifies to a usable npm name', () => {
    expect(slugify('Ember & Oak')).toBe('ember-oak');
    expect(slugify('   ')).toBe('app');
    expect(slugify('---')).toBe('app');
  });
});
