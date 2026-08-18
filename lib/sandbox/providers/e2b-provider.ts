import { Sandbox } from '@e2b/code-interpreter';
import { SandboxProvider, SandboxInfo, CommandResult, SandboxProviderConfig } from '../types';
import { appConfig } from '@/config/app.config';
import { DEFAULT_STACK, getSandboxTemplate, getStack, shouldInstallPackages, type StackId } from '@/lib/stacks';
import {
  getStackSetupPlan,
  stackScaffoldFiles,
} from '@/lib/sandbox/stack-setup';
import { DRIVER_CAPABILITIES, DRIVER_COST_MODELS, type InjectedSandboxClient } from '../provider';
import {
  lastCommandOutput,
  sandboxListUnreadableMessage,
  sandboxMissingPreviewUrlMessage,
  sandboxNpmInstallFailedMessage,
  sandboxReconnectMissingPreviewUrlMessage,
  sandboxReconnectUncertainMessage,
} from '../boot-errors';
import { commandResultFromE2BExecution } from '../e2b-command-result';
import {
  runTeardown,
  teardownAlreadyGone,
  teardownProvider,
  type TeardownResult,
} from '../teardown';

type E2BRunResult = {
  error?: { name?: string; value?: string } | null;
  logs?: { stdout?: string[]; stderr?: string[] };
};

/** Positive evidence the VM is gone — not a timeout, auth failure, or network blip. */
export function isE2BSandboxGone(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const name = error instanceof Error ? error.name : '';
  if (name === 'FileNotFoundError') return false;
  if (name === 'SandboxNotFoundError' || name === 'NotFoundError') return true;
  const statusCode =
    'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : Number.NaN;
  if (statusCode === 404 || statusCode === 410) return true;
  const message = error instanceof Error ? error.message : '';
  return /\b(404|410)\b/.test(message) || /\bnot found\b/i.test(message) || /\bno longer exists\b/i.test(message);
}

/** getHost(undefined) interpolates to the string "https://undefined" — refuse that. */
function usableE2BHost(host: unknown): string | null {
  if (typeof host !== 'string') return null;
  const trimmed = host.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return null;
  return trimmed;
}

type E2BConstructorConfig = SandboxProviderConfig | { apiKey: string };

export class E2BProvider extends SandboxProvider {
  readonly driver = 'e2b' as const;
  readonly capabilities = DRIVER_CAPABILITIES.e2b;
  readonly costModel = DRIVER_COST_MODELS.e2b;
  private existingFiles: Set<string> = new Set();
  private currentStack: StackId = DEFAULT_STACK;
  private injected: InjectedSandboxClient | null = null;

  constructor(config: E2BConstructorConfig = {}, options?: { client?: InjectedSandboxClient }) {
    const apiKey =
      'e2b' in config && config.e2b
        ? config.e2b.apiKey || ''
        : 'apiKey' in config
          ? (config as { apiKey: string }).apiKey
          : '';
    super({
      e2b: {
        apiKey,
        timeoutMs: 'e2b' in config ? config.e2b?.timeoutMs : undefined,
        template: 'e2b' in config ? config.e2b?.template : undefined,
      },
    });
    this.injected = options?.client ?? null;
  }

  private apiKey() {
    return this.config.e2b?.apiKey || '';
  }

  /**
   * Probe / attach to an existing E2B sandbox. Times out in 3s by default.
   */
  async reconnect(sandboxId: string, timeoutMs = 3000): Promise<boolean> {
    if (this.injected) {
      const alive = await this.injected.reconnect(sandboxId);
      if (alive) {
        this.sandbox = { injected: true };
        this.sandboxInfo = {
          sandboxId,
          url: this.injected.getPreviewUrl() || '',
          provider: 'e2b',
          createdAt: new Date(),
        };
      }
      return alive;
    }
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const apiKey = this.apiKey();
      const connected = await Promise.race([
        Sandbox.connect(sandboxId, { apiKey, timeoutMs: this.config.e2b?.timeoutMs || appConfig.e2b.timeoutMs }),
        new Promise<never>((_, reject) => {
          probeTimer = setTimeout(() => reject(new Error('E2B probe timed out')), timeoutMs);
          probeTimer.unref?.();
        }),
      ]);

      this.sandbox = connected;
      const host = usableE2BHost(
        (this.sandbox as { getHost?: (port: number) => string }).getHost?.(appConfig.e2b.vitePort),
      );
      if (!host) {
        this.sandbox = null;
        this.sandboxInfo = null;
        throw new Error(sandboxReconnectMissingPreviewUrlMessage('e2b', appConfig.e2b.vitePort));
      }
      this.sandboxInfo = {
        sandboxId,
        url: `https://${host}`,
        provider: 'e2b',
        createdAt: new Date(),
      };
      if (typeof this.sandbox.setTimeout === 'function') {
        this.sandbox.setTimeout(this.config.e2b?.timeoutMs || appConfig.e2b.timeoutMs);
      }
      return true;
    } catch (error) {
      this.sandbox = null;
      this.sandboxInfo = null;
      if (error instanceof Error && error.message === sandboxReconnectMissingPreviewUrlMessage('e2b', appConfig.e2b.vitePort)) {
        throw error;
      }
      if (isE2BSandboxGone(error)) return false;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(sandboxReconnectUncertainMessage('e2b', detail));
    } finally {
      if (probeTimer) clearTimeout(probeTimer);
    }
  }

  async createSandbox(stack: string = DEFAULT_STACK): Promise<SandboxInfo> {
    if (this.injected) {
      const created = await this.injected.create({ stack });
      this.sandbox = { injected: true };
      this.sandboxInfo = {
        sandboxId: created.id,
        url: created.previewUrl || this.injected.getPreviewUrl() || '',
        provider: 'e2b',
        createdAt: new Date(),
      };
      return this.sandboxInfo;
    }
    try {
      const definition = getStack(stack);
      this.currentStack = definition.id;
      const template = getSandboxTemplate(definition.id);
      
      // Kill existing sandbox if any
      if (this.sandbox) {
        try {
          await this.sandbox.kill();
        } catch (e) {
          console.error('Failed to close existing sandbox:', e);
        }
        this.sandbox = null;
      }
      
      // Clear existing files tracking
      this.existingFiles.clear();

      // Official generic Node image (code-interpreter-v1). Looked up from the
      // stack registry — not a hardcoded create() default, not an invented template.
      this.sandbox = await Sandbox.create(template.e2b, { 
        apiKey: this.apiKey(),
        timeoutMs: this.config.e2b?.timeoutMs || appConfig.e2b.timeoutMs
      });
      
      const sandboxId = (this.sandbox as any).sandboxId || Date.now().toString();
      const host = usableE2BHost((this.sandbox as any).getHost?.(appConfig.e2b.vitePort));
      if (!host) {
        const outcome = await teardownProvider(this);
        throw new Error(sandboxMissingPreviewUrlMessage('e2b', appConfig.e2b.vitePort, outcome));
      }

      this.sandboxInfo = {
        sandboxId,
        url: `https://${host}`,
        provider: 'e2b',
        createdAt: new Date()
      };

      // Set extended timeout on the sandbox instance if method available
      if (typeof this.sandbox.setTimeout === 'function') {
        this.sandbox.setTimeout(appConfig.e2b.timeoutMs);
      }

      return this.sandboxInfo;

    } catch (error) {
      console.error('[E2BProvider] Error creating sandbox:', error);
      await teardownProvider(this);
      throw error;
    }
  }

  /**
   * E2B cells are Python and Python is whitespace-sensitive: the indented
   * template literals this file writes arrive at the kernel with their
   * TypeScript indentation and die on IndentationError before running a
   * single line — which is why every runCommand returned exit 1 with empty
   * streams and the provider never tested healthy. Strip the common leading
   * indent (textwrap.dedent semantics) at this one boundary.
   */
  static dedentPythonCell(code: string): string {
    const lines = code.replace(/^\n/, '').split('\n');
    const indents = lines
      .filter((line) => line.trim())
      .map((line) => (line.match(/^[ \t]*/) as RegExpMatchArray)[0].length);
    const common = indents.length ? Math.min(...indents) : 0;
    return lines.map((line) => line.slice(common)).join('\n');
  }

  private runPython(code: string) {
    if (!this.sandbox) {
      throw new Error('No active sandbox');
    }
    return this.sandbox.runCode(E2BProvider.dedentPythonCell(code));
  }

  async runCommand(command: string): Promise<CommandResult> {
    if (this.injected) {
      const result = await this.injected.run(command);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        success: result.exitCode === 0,
      };
    }
    if (!this.sandbox) {
      throw new Error('No active sandbox');
    }

    
    const result = await this.runPython(`
      import subprocess
      import os

      os.makedirs('/home/user/app', exist_ok=True)
      os.chdir('/home/user/app')
      result = subprocess.run(${JSON.stringify(command.split(' '))}, 
                            capture_output=True, 
                            text=True, 
                            shell=False)

      print("STDOUT:")
      print(result.stdout)
      if result.stderr:
          print("\\nSTDERR:")
          print(result.stderr)
      print(f"\\nReturn code: {result.returncode}")
    `);
    
    return commandResultFromE2BExecution(result);
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (this.injected) {
      await this.injected.writeFile(path, content);
      this.existingFiles.add(path);
      return;
    }
    if (!this.sandbox) {
      throw new Error('No active sandbox');
    }

    const fullPath = path.startsWith('/') ? path : `/home/user/app/${path}`;
    
    // Use the E2B filesystem API to write the file
    // Note: E2B SDK uses files.write() method
    if ((this.sandbox as any).files && typeof (this.sandbox as any).files.write === 'function') {
      // Use the files.write API if available
      await (this.sandbox as any).files.write(fullPath, Buffer.from(content));
    } else {
      // Fallback to Python code execution
      await this.runPython(`
        import os

        # Ensure directory exists
        dir_path = os.path.dirname("${fullPath}")
        os.makedirs(dir_path, exist_ok=True)

        # Write file
        with open("${fullPath}", 'w') as f:
            f.write(${JSON.stringify(content)})
        print(f"✓ Written: ${fullPath}")
      `);
    }
    
    this.existingFiles.add(path);
  }

  async readFile(path: string): Promise<string> {
    if (this.injected) return this.injected.readFile(path);
    if (!this.sandbox) {
      throw new Error('No active sandbox');
    }

    const fullPath = path.startsWith('/') ? path : `/home/user/app/${path}`;
    
    const result = await this.runPython(`
      with open("${fullPath}", 'r') as f:
          content = f.read()
      print(content)
    `);
    
    return result.logs.stdout.join('\n');
  }

  async listFiles(directory: string = '/home/user/app'): Promise<string[]> {
    if (this.injected) return this.injected.listFiles(directory);
    if (!this.sandbox) {
      throw new Error('No active sandbox');
    }

    const result = await this.runPython(`
      import os
      import json

      def list_files(path):
          files = []
          for root, dirs, filenames in os.walk(path):
              # Skip node_modules and .git
              dirs[:] = [d for d in dirs if d not in ['node_modules', '.git', '.next', 'dist', 'build']]
              for filename in filenames:
                  rel_path = os.path.relpath(os.path.join(root, filename), path)
                  files.append(rel_path)
          return files

      files = list_files("${directory}")
      print(json.dumps(files))
    `);
    
    const stdout = result.logs?.stdout?.join('') ?? '';
    const pythonError = typeof result.error?.value === 'string' ? result.error.value.trim() : '';
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
        throw new Error('not a JSON array of paths');
      }
      return parsed;
    } catch (error) {
      const detail = pythonError || (error instanceof Error ? error.message : String(error));
      throw new Error(sandboxListUnreadableMessage('e2b', detail));
    }
  }

  async installPackages(packages: string[]): Promise<CommandResult> {
    if (!this.sandbox) {
      throw new Error('No active sandbox');
    }

    if (!shouldInstallPackages(this.currentStack)) {
      return {
        stdout: `skip install: ${this.currentStack} has no node dependencies`,
        stderr: '',
        exitCode: 0,
        success: true,
      };
    }

    const packageList = packages.join(' ');
    const flags = appConfig.packages.useLegacyPeerDeps ? '--legacy-peer-deps' : '';
    
    
    const result = await this.runPython(`
      import subprocess
      import os

      os.chdir('/home/user/app')

      # Install packages
      result = subprocess.run(
          ['npm', 'install', ${flags ? `'${flags}',` : ''} ${packages.map(p => `'${p}'`).join(', ')}],
          capture_output=True,
          text=True
      )

      print("STDOUT:")
      print(result.stdout)
      if result.stderr:
          print("\\nSTDERR:")
          print(result.stderr)
      print(f"\\nReturn code: {result.returncode}")
    `);
    
    const command = commandResultFromE2BExecution(result);

    // Restart Vite if configured
    if (appConfig.packages.autoRestartVite && command.success) {
      await this.restartViteServer();
    }

    return command;
  }

  async setupViteApp(stack: string = DEFAULT_STACK): Promise<void> {
    if (!this.sandbox) {
      throw new Error('No active sandbox');
    }

    this.currentStack = getStack(stack).id;
    if (this.currentStack !== 'REACT') {
      await this.setupRegistryApp(this.currentStack);
      return;
    }

    
    // Write all files in a single Python script
    const setupScript = `
import os
import json

print('Setting up React app with Vite and Tailwind...')

# Create directory structure
os.makedirs('/home/user/app/src', exist_ok=True)

# Package.json
package_json = {
    "name": "sandbox-app",
    "version": "1.0.0",
    "type": "module",
    "scripts": {
        "dev": "vite --host",
        "build": "vite build",
        "preview": "vite preview"
    },
    "dependencies": {
        "react": "^18.2.0",
        "react-dom": "^18.2.0"
    },
    "devDependencies": {
        "@vitejs/plugin-react": "^4.0.0",
        "vite": "^4.3.9",
        "tailwindcss": "^3.3.0",
        "postcss": "^8.4.31",
        "autoprefixer": "^10.4.16"
    }
}

with open('/home/user/app/package.json', 'w') as f:
    json.dump(package_json, f, indent=2)
print('✓ package.json')

# Vite config
vite_config = """import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    hmr: false,
    allowedHosts: ['.e2b.app', '.e2b.dev', '.vercel.run', 'localhost', '127.0.0.1']
  }
})"""

with open('/home/user/app/vite.config.js', 'w') as f:
    f.write(vite_config)
print('✓ vite.config.js')

# Tailwind config
tailwind_config = """/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}"""

with open('/home/user/app/tailwind.config.js', 'w') as f:
    f.write(tailwind_config)
print('✓ tailwind.config.js')

# PostCSS config
postcss_config = """export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}"""

with open('/home/user/app/postcss.config.js', 'w') as f:
    f.write(postcss_config)
print('✓ postcss.config.js')

# Index.html
index_html = """<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sandbox App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>"""

with open('/home/user/app/index.html', 'w') as f:
    f.write(index_html)
print('✓ index.html')

# Main.jsx
main_jsx = """import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)"""

with open('/home/user/app/src/main.jsx', 'w') as f:
    f.write(main_jsx)
print('✓ src/main.jsx')

# App.jsx
app_jsx = """function App() {
  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
      <div className="text-center max-w-2xl">
        <p className="text-lg text-gray-400">
          Sandbox Ready<br/>
          Start building your React app with Vite and Tailwind CSS!
        </p>
      </div>
    </div>
  )
}

export default App"""

with open('/home/user/app/src/App.jsx', 'w') as f:
    f.write(app_jsx)
print('✓ src/App.jsx')

# Index.css
index_css = """@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
  background-color: rgb(17 24 39);
}"""

with open('/home/user/app/src/index.css', 'w') as f:
    f.write(index_css)
print('✓ src/index.css')

print('\\nAll files created successfully!')
`;

    await this.runPython(setupScript);
    
    // Install dependencies
    const installResult = await this.runPython(`
import subprocess

print('Installing npm packages...')
result = subprocess.run(
    ['npm', 'install'],
    cwd='/home/user/app',
    capture_output=True,
    text=True
)

if result.returncode == 0:
    print('✓ Dependencies installed successfully')
else:
    raise RuntimeError('npm install failed: ' + (result.stderr or result.stdout or 'unknown'))
    `);
    await this.assertE2BInstallSucceeded(installResult);
    
    // Start Vite dev server
    await this.runPython(`
import subprocess
import os
import time

os.chdir('/home/user/app')

# Kill any existing Vite processes
subprocess.run(['pkill', '-f', 'vite'], capture_output=True)
time.sleep(1)

# Start Vite dev server
env = os.environ.copy()
env['FORCE_COLOR'] = '0'

process = subprocess.Popen(
    ['npm', 'run', 'dev'],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env
)

print(f'✓ Vite dev server started with PID: {process.pid}')
print('Waiting for server to be ready...')
    `);
    
    // Wait for Vite to be ready
    await new Promise(resolve => setTimeout(resolve, appConfig.e2b.viteStartupDelay));
    
    // Track initial files
    this.existingFiles.add('src/App.jsx');
    this.existingFiles.add('src/main.jsx');
    this.existingFiles.add('src/index.css');
    this.existingFiles.add('index.html');
    this.existingFiles.add('package.json');
    this.existingFiles.add('vite.config.js');
    this.existingFiles.add('tailwind.config.js');
    this.existingFiles.add('postcss.config.js');
  }

  /**
   * Non-REACT stacks: write registry scaffold files, then registry install/dev.
   * Image is getStack().sandboxTemplate.e2b (generic Node). STATIC_HTML skips install.
   */
  private async setupRegistryApp(stack: StackId): Promise<void> {
    if (!this.sandbox) {
      throw new Error('No active sandbox');
    }

    const plan = getStackSetupPlan(stack);
    const files = stackScaffoldFiles(stack);

    await this.runPython(`
import os
os.makedirs('/home/user/app', exist_ok=True)
    `);

    for (const file of files) {
      await this.writeFile(file.path, file.content);
    }

    const installArgs = plan.installArgs ? JSON.stringify(plan.installArgs) : 'None';
    const startArgs = plan.skipInstall
      ? JSON.stringify(plan.devArgs)
      : JSON.stringify(['npm', 'run', 'dev']);
    const devLabel = JSON.stringify(plan.devCommand);

    const registryResult = await this.runPython(`
import os
import subprocess
import time

os.chdir('/home/user/app')

if ${plan.skipInstall ? 'True' : 'False'}:
    print('skip install: hasNodeDependencies is false')
else:
    result = subprocess.run(${installArgs}, cwd='/home/user/app', capture_output=True, text=True)
    if result.returncode == 0:
        print('✓ Dependencies installed')
    else:
        raise RuntimeError('npm install failed: ' + (result.stderr or result.stdout or 'unknown'))

subprocess.run(['pkill', '-f', ${JSON.stringify(plan.devArgs[0])}], capture_output=True)
time.sleep(1)
env = os.environ.copy()
env['FORCE_COLOR'] = '0'
process = subprocess.Popen(${startArgs}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
print('✓ Dev server started (' + ${devLabel} + f' PID {process.pid})')
    `);
    if (!plan.skipInstall) {
      await this.assertE2BInstallSucceeded(registryResult);
    }

    await new Promise((resolve) => setTimeout(resolve, appConfig.e2b.viteStartupDelay));
    for (const file of files) {
      this.existingFiles.add(file.path);
    }
  }

  async installAndStartDev(stack: string = DEFAULT_STACK): Promise<void> {
    if (!this.sandbox) {
      throw new Error('No active sandbox');
    }

    this.currentStack = getStack(stack).id;
    const plan = getStackSetupPlan(this.currentStack);
    const installArgs = plan.installArgs ? JSON.stringify(plan.installArgs) : 'None';
    const startArgs = plan.skipInstall
      ? JSON.stringify(plan.devArgs)
      : JSON.stringify(['npm', 'run', 'dev']);
    const devLabel = JSON.stringify(plan.devCommand);

    const restoreResult = await this.runPython(`
import os
import subprocess
import time

os.makedirs('/home/user/app', exist_ok=True)
os.chdir('/home/user/app')

if ${plan.skipInstall ? 'True' : 'False'}:
    print('skip install: hasNodeDependencies is false')
else:
    result = subprocess.run(${installArgs}, cwd='/home/user/app', capture_output=True, text=True)
    if result.returncode == 0:
        print('✓ Dependencies installed')
    else:
        raise RuntimeError('npm install failed: ' + (result.stderr or result.stdout or 'unknown'))

subprocess.run(['pkill', '-f', ${JSON.stringify(plan.devArgs[0])}], capture_output=True)
time.sleep(1)
env = os.environ.copy()
env['FORCE_COLOR'] = '0'
process = subprocess.Popen(${startArgs}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
print('✓ Dev server started (' + ${devLabel} + f' PID {process.pid})')
    `);
    if (!plan.skipInstall) {
      await this.assertE2BInstallSucceeded(restoreResult);
    }
  }

  private async assertE2BInstallSucceeded(result: E2BRunResult): Promise<void> {
    if (!result.error) return;
    const stdout = (result.logs?.stdout ?? []).join('\n');
    const stderr = (result.logs?.stderr ?? []).join('\n');
    const output = lastCommandOutput(stdout, stderr) || result.error.value || '';
    const outcome = await teardownProvider(this);
    const message = sandboxNpmInstallFailedMessage('e2b', 1, output, outcome);
    throw new Error(message);
  }

  async restartViteServer(): Promise<void> {
    if (!this.sandbox) {
      throw new Error('No active sandbox');
    }

    if (this.currentStack !== 'REACT') {
      const plan = getStackSetupPlan(this.currentStack);
      await this.runPython(`
import subprocess
import time
import os

os.chdir('/home/user/app')
subprocess.run(['pkill', '-f', ${JSON.stringify(plan.devArgs[0])}], capture_output=True)
time.sleep(2)
env = os.environ.copy()
env['FORCE_COLOR'] = '0'
process = subprocess.Popen(${JSON.stringify(plan.devArgs)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
print('✓ Dev server restarted (' + ${JSON.stringify(plan.devCommand)} + f' PID {process.pid})')
      `);
      await new Promise((resolve) => setTimeout(resolve, appConfig.e2b.viteStartupDelay));
      return;
    }

    
    await this.runPython(`
import subprocess
import time
import os

os.chdir('/home/user/app')

# Kill existing Vite process
subprocess.run(['pkill', '-f', 'vite'], capture_output=True)
time.sleep(2)

# Start Vite dev server
env = os.environ.copy()
env['FORCE_COLOR'] = '0'

process = subprocess.Popen(
    ['npm', 'run', 'dev'],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env
)

print(f'✓ Vite restarted with PID: {process.pid}')
    `);
    
    // Wait for Vite to be ready
    await new Promise(resolve => setTimeout(resolve, appConfig.e2b.viteStartupDelay));
  }

  getSandboxUrl(): string | null {
    return this.sandboxInfo?.url || null;
  }

  getSandboxInfo(): SandboxInfo | null {
    return this.sandboxInfo;
  }

  async terminate(): Promise<TeardownResult> {
    const sandboxId =
      this.sandboxInfo?.sandboxId ??
      (this.sandbox && typeof this.sandbox === 'object' && 'sandboxId' in this.sandbox
        ? String((this.sandbox as { sandboxId?: unknown }).sandboxId ?? '') || null
        : null);
    if (this.injected) {
      const outcome = await runTeardown(sandboxId, () => this.injected!.kill(), () => false);
      if (outcome.status !== 'could_not_stop') {
        this.sandbox = null;
        this.sandboxInfo = null;
      }
      return outcome;
    }
    if (!this.sandbox) return teardownAlreadyGone(sandboxId);
    const outcome = await runTeardown(sandboxId, () => this.sandbox.kill(), isE2BSandboxGone);
    if (outcome.status !== 'could_not_stop') {
      this.sandbox = null;
      this.sandboxInfo = null;
    }
    return outcome;
  }

  isAlive(): boolean {
    return !!this.sandbox;
  }
}