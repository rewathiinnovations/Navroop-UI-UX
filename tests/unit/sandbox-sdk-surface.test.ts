import dns from 'node:dns';
import net from 'node:net';
import { describe, expect, it } from 'vitest';

/**
 * Pins the real `@e2b/code-interpreter`, `modal` and `@daytona/sdk` surfaces that
 * `lib/sandbox/providers/*` reaches for on its live (non-injected) path.
 *
 * `tests/sandbox-providers.test.ts` builds every driver with an injected client, so
 * `this.injected` short-circuits before a single SDK call happens, and nothing else in
 * the repo imports these three packages. Without this file an SDK could rename or
 * reshape any member below and every test would stay green until a real cold start
 * failed in production. `modal` and `@daytona/sdk` are pinned to exact 0.x versions
 * precisely because their minors move.
 *
 * Two things this file deliberately does not do:
 *
 *   - It never boots a sandbox and never reaches the network. An outbound trap is
 *     installed *before* the dynamic imports below and asserted clean afterwards, so an
 *     SDK that dialled out at module load or from a constructor would fail here rather
 *     than quietly phone home. Every credential passed in is a placeholder.
 *   - It never skips. If a package cannot be imported, or a client cannot be built
 *     offline, the failure is stored and re-thrown by a test rather than swallowed.
 *
 * Enforcement is at runtime. `tsconfig.json` excludes `tests`, so the `satisfies` pins
 * further down are checked by editors and by a direct `tsc` run over this file, but not
 * by `pnpm run verify`. Every member a driver calls therefore also has a runtime
 * assertion; the type pins only carry the shapes runtime cannot see without a live
 * call, such as the fields on a resolved response.
 */

type E2BModule = typeof import('@e2b/code-interpreter');
type ModalModule = typeof import('modal');
type DaytonaModule = typeof import('@daytona/sdk');

type SdkProbes = {
  e2bModule: E2BModule;
  /** Built locally from a fake id and key. Never connected, never used to run code. */
  e2bSandbox: InstanceType<E2BModule['Sandbox']>;
  modalModule: ModalModule;
  /** `apps` / `images` / `sandboxes` are instance fields, so a client is required. */
  modalClient: InstanceType<ModalModule['ModalClient']>;
  /** `sandboxId` is an instance field too, and `new Sandbox(client, id)` needs no API. */
  modalSandbox: InstanceType<ModalModule['Sandbox']>;
  daytonaModule: DaytonaModule;
  daytonaClient: InstanceType<DaytonaModule['Daytona']>;
};

// --- outbound trap -----------------------------------------------------------------

const outboundAttempts: string[] = [];

const realSocketConnect = net.Socket.prototype.connect;
const realDnsLookup = dns.lookup;
const realFetch = globalThis.fetch;

function refuse(what: string): never {
  outboundAttempts.push(what);
  throw new Error(
    `The sandbox SDK surface check attempted ${what}. This suite checks shapes only; it must never reach E2B, Modal or Daytona.`,
  );
}

function installOutboundTrap() {
  net.Socket.prototype.connect = (() =>
    refuse('a TCP connection')) as typeof net.Socket.prototype.connect;
  dns.lookup = (() => refuse('a DNS lookup')) as unknown as typeof dns.lookup;
  globalThis.fetch = (() => refuse('an HTTP request')) as typeof globalThis.fetch;
}

function removeOutboundTrap() {
  net.Socket.prototype.connect = realSocketConnect;
  dns.lookup = realDnsLookup;
  globalThis.fetch = realFetch;
}

// --- load the real packages, offline -----------------------------------------------

let loadFailure: unknown = null;
let probes: SdkProbes | null = null;

/**
 * A Daytona `Sandbox` is normally handed back by `client.create()`. Building one
 * directly is the only way to check at runtime that `sandbox.id`, `sandbox.fs` and
 * `sandbox.process` are really there, so the constructor's collaborators are stubbed.
 * Kept apart from the probes above: if a future `@daytona/sdk` reshuffles those
 * collaborators this fails on its own instead of taking every other pin down with it.
 */
let daytonaSandbox: InstanceType<DaytonaModule['Sandbox']> | null = null;
let daytonaSandboxFailure: unknown = null;

installOutboundTrap();
try {
  const e2bModule = await import('@e2b/code-interpreter');
  const modalModule = await import('modal');
  const daytonaModule = await import('@daytona/sdk');

  const e2bSandbox = new e2bModule.Sandbox({
    sandboxId: 'surface-check-never-connected',
    envdVersion: '0.0.0',
    apiKey: 'surface-check-not-a-real-key',
  });
  const modalClient = new modalModule.ModalClient({
    tokenId: 'surface-check-not-a-real-token-id',
    tokenSecret: 'surface-check-not-a-real-token-secret',
  });
  const modalSandbox = new modalModule.Sandbox(modalClient, 'surface-check-never-created');
  const daytonaClient = new daytonaModule.Daytona({
    apiKey: 'surface-check-not-a-real-key',
    apiUrl: 'https://sandbox-sdk-surface.invalid',
  });

  probes = {
    e2bModule,
    e2bSandbox,
    modalModule,
    modalClient,
    modalSandbox,
    daytonaModule,
    daytonaClient,
  };
  modalClient.close();

  type DaytonaSandboxArgs = ConstructorParameters<DaytonaModule['Sandbox']>;
  try {
    daytonaSandbox = new daytonaModule.Sandbox(
      {
        id: 'surface-check-never-created',
        name: 'surface-check',
        organizationId: 'surface-check',
        user: 'surface-check',
        labels: {},
        public: true,
        target: 'surface-check',
        cpu: 1,
        gpu: 0,
        memory: 1,
        disk: 1,
        toolboxProxyUrl: 'https://sandbox-sdk-surface.invalid',
      } as unknown as DaytonaSandboxArgs[0],
      { basePath: 'https://sandbox-sdk-surface.invalid' } as unknown as DaytonaSandboxArgs[1],
      {
        defaults: { baseURL: '', headers: { common: {} } },
        interceptors: { request: { use() {} }, response: { use() {} } },
      } as unknown as DaytonaSandboxArgs[2],
      {} as unknown as DaytonaSandboxArgs[3],
      async () => undefined,
      {
        subscribe: () => () => {},
        unsubscribe: () => {},
      } as unknown as DaytonaSandboxArgs[5],
    );
  } catch (error) {
    daytonaSandboxFailure = error;
  }
} catch (error) {
  loadFailure = error;
} finally {
  removeOutboundTrap();
}

function sdk(): SdkProbes {
  if (!probes) {
    throw new Error(
      `The sandbox SDKs could not be loaded offline: ${describeError(loadFailure)}`,
    );
  }
  return probes;
}

function daytonaSandboxProbe(): InstanceType<DaytonaModule['Sandbox']> {
  if (!daytonaSandbox) {
    throw new Error(
      '@daytona/sdk Sandbox could no longer be constructed offline: ' +
        `${describeError(daytonaSandboxFailure)}. Either the members daytona-provider.ts calls have moved, ` +
        'or the constructor collaborators this test stubs have. Both are worth reviewing on an exact 0.x pin.',
    );
  }
  return daytonaSandbox;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- member probing ----------------------------------------------------------------

type MemberKind = 'method' | 'getter' | 'data' | 'missing';

/**
 * Walks the prototype chain by descriptor. Reading `Sandbox.prototype.filesystem`
 * directly would invoke an accessor against the prototype; a descriptor read cannot.
 */
function memberKind(target: object, key: string): MemberKind {
  let current: object | null = target;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (typeof descriptor.get === 'function') return 'getter';
      if (typeof descriptor.value === 'function') return 'method';
      return 'data';
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return 'missing';
}

function readMember(owner: object, key: string): unknown {
  return (owner as Record<string, unknown>)[key];
}

function arityOf(owner: object, key: string): number {
  const value = readMember(owner, key);
  if (typeof value !== 'function') {
    throw new Error(`${key} is not a function on the installed SDK`);
  }
  return value.length;
}

type SurfacePin = {
  /** Verbatim enough to grep for in the driver. */
  driverCall: string;
  /** Where the driver makes that call. */
  source: string;
  owner: () => object;
  key: string;
  /**
   * `constructor` reads the value and requires a class. The other three compare the
   * property descriptor, which never invokes an accessor. Module exports have to use
   * `constructor`: an ES module namespace publishes its bindings as getters and a
   * CommonJS one as plain values, and that difference is a packaging detail rather
   * than anything the SDK promises.
   */
  kind: Exclude<MemberKind, 'missing'> | 'constructor';
};

function pinSuite(title: string, pins: SurfacePin[]) {
  describe(title, () => {
    it('pins at least one member', () => {
      expect(pins.length).toBeGreaterThan(0);
    });

    for (const pin of pins) {
      it(`${pin.driverCall} — ${pin.source}`, () => {
        if (pin.kind === 'constructor') {
          const exported = readMember(pin.owner(), pin.key);
          expect(typeof exported).toBe('function');
          expect(typeof (exported as { prototype?: unknown }).prototype).toBe('object');
          return;
        }
        expect(memberKind(pin.owner(), pin.key)).toBe(pin.kind);
      });
    }
  });
}

// --- the SDKs have to be usable offline in the first place -------------------------

describe('sandbox SDKs load and construct without credentials or network', () => {
  it('imports all three packages and builds a client for each', () => {
    expect(loadFailure).toBeNull();
    expect(probes).not.toBeNull();
  });

  it('builds a Daytona Sandbox offline', () => {
    expect(daytonaSandboxFailure).toBeNull();
    expect(daytonaSandbox).not.toBeNull();
  });

  it('made no outbound connection while importing or constructing', () => {
    expect(outboundAttempts).toEqual([]);
  });

  it('reports a member that does not exist', () => {
    // Without this the tables below could be asserting nothing at all.
    expect(memberKind(sdk().e2bModule.Sandbox, 'createSandboxDefinitelyNotAMethod')).toBe('missing');
    expect(memberKind(sdk().modalSandbox, 'notAModalMethod')).toBe('missing');
    expect(memberKind(sdk().daytonaModule.Daytona.prototype, 'notADaytonaMethod')).toBe('missing');
  });
});

// --- E2B ---------------------------------------------------------------------------

pinSuite('lib/sandbox/providers/e2b-provider.ts against @e2b/code-interpreter', [
  {
    driverCall: "import { Sandbox } from '@e2b/code-interpreter'",
    source: 'e2b-provider.ts:1',
    owner: () => sdk().e2bModule,
    key: 'Sandbox',
    kind: 'constructor',
  },
  {
    driverCall: 'Sandbox.connect(sandboxId, { apiKey, timeoutMs })',
    source: 'reconnect, e2b-provider.ts:97',
    owner: () => sdk().e2bModule.Sandbox,
    key: 'connect',
    kind: 'method',
  },
  {
    driverCall: 'Sandbox.create(template.e2b, { apiKey, timeoutMs })',
    source: 'createSandbox, e2b-provider.ts:124',
    owner: () => sdk().e2bModule.Sandbox,
    key: 'create',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.sandboxId',
    source: 'createSandbox, e2b-provider.ts:129',
    owner: () => sdk().e2bSandbox,
    key: 'sandboxId',
    kind: 'data',
  },
  {
    driverCall: 'sandbox.getHost(vitePort)',
    source: 'reconnect and createSandbox, e2b-provider.ts:71 and :130',
    owner: () => sdk().e2bSandbox,
    key: 'getHost',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.setTimeout(timeoutMs)',
    source: 'reconnect and createSandbox, e2b-provider.ts:79 and :142',
    owner: () => sdk().e2bSandbox,
    key: 'setTimeout',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.kill()',
    source: 'createSandbox and terminate, e2b-provider.ts:112 and :734',
    owner: () => sdk().e2bSandbox,
    key: 'kill',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.runCode(python)',
    source: 'runCommand and every other live method, e2b-provider.ts:168 onwards',
    owner: () => sdk().e2bSandbox,
    key: 'runCode',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.files',
    source: 'writeFile, e2b-provider.ts:211',
    owner: () => sdk().e2bSandbox,
    key: 'files',
    kind: 'data',
  },
  {
    driverCall: 'sandbox.files.write(fullPath, Buffer.from(content))',
    source: 'writeFile, e2b-provider.ts:213',
    owner: () => sdk().e2bSandbox.files,
    key: 'write',
    kind: 'method',
  },
]);

describe('@e2b/code-interpreter call shapes', () => {
  it('create and connect still take an id or template plus an options bag', () => {
    expect(arityOf(sdk().e2bModule.Sandbox, 'create')).toBe(2);
    expect(arityOf(sdk().e2bModule.Sandbox, 'connect')).toBe(2);
  });

  it('getHost takes a port, runCode takes code plus options, files.write takes a path plus a payload', () => {
    expect(arityOf(sdk().e2bSandbox, 'getHost')).toBe(1);
    expect(arityOf(sdk().e2bSandbox, 'runCode')).toBe(2);
    expect(arityOf(sdk().e2bSandbox.files, 'write')).toBe(3);
  });

  it('create and connect still accept the apiKey and timeoutMs the driver passes', () => {
    type CreateOpts = NonNullable<Parameters<E2BModule['Sandbox']['create']>[1]>;
    type ConnectOpts = NonNullable<Parameters<E2BModule['Sandbox']['connect']>[1]>;
    const createOpts: CreateOpts = { apiKey: 'surface-check', timeoutMs: 300_000 };
    const connectOpts: ConnectOpts = { apiKey: 'surface-check', timeoutMs: 300_000 };
    expect(createOpts.timeoutMs).toBe(300_000);
    expect(connectOpts.timeoutMs).toBe(300_000);
  });

  it('runCode still resolves to logs.stdout / logs.stderr string arrays and an optional error', () => {
    // `result.logs.stdout.join('\n')`. `error` is a Python exception, not a
    // subprocess exit code — `commandResultFromE2BExecution` parses `Return code: N`.
    type Execution = Awaited<ReturnType<InstanceType<E2BModule['Sandbox']>['runCode']>>;
    const execution: Pick<Execution, 'logs' | 'error'> = {
      logs: { stdout: [], stderr: [] },
      error: undefined,
    };
    expect(Array.isArray(execution.logs.stdout)).toBe(true);
    expect(Array.isArray(execution.logs.stderr)).toBe(true);
    expect(execution.error).toBeUndefined();
  });

  /**
   * `e2b-provider.ts:211-213` casts the sandbox to `any` before touching `files`, so
   * `Buffer.from(content)` is never checked against the declared payload union.
   */
  it('files.write does not declare Buffer among its payload types', () => {
    type WriteData = Parameters<InstanceType<E2BModule['Sandbox']>['files']['write']>[1];
    const bufferIsDeclared = false satisfies (Buffer extends WriteData ? true : false);
    expect(bufferIsDeclared).toBe(false);
  });
});

// --- Modal -------------------------------------------------------------------------

pinSuite('lib/sandbox/providers/modal-provider.ts against modal', [
  {
    driverCall: "(await import('modal')).ModalClient",
    source: 'loadModalSdk, modal-provider.ts:171',
    owner: () => sdk().modalModule,
    key: 'ModalClient',
    kind: 'constructor',
  },
  {
    driverCall: 'client.apps',
    source: 'createSandbox, modal-provider.ts:97',
    owner: () => sdk().modalClient,
    key: 'apps',
    kind: 'data',
  },
  {
    driverCall: "client.apps.fromName('navroop-sandbox', { createIfMissing: true })",
    source: 'createSandbox, modal-provider.ts:97',
    owner: () => sdk().modalClient.apps,
    key: 'fromName',
    kind: 'method',
  },
  {
    driverCall: 'client.images',
    source: 'createSandbox, modal-provider.ts:98',
    owner: () => sdk().modalClient,
    key: 'images',
    kind: 'data',
  },
  {
    driverCall: 'client.images.fromRegistry(MODAL_SANDBOX_IMAGE)',
    source: 'createSandbox, modal-provider.ts:98',
    owner: () => sdk().modalClient.images,
    key: 'fromRegistry',
    kind: 'method',
  },
  {
    driverCall: 'client.sandboxes',
    source: 'createSandbox, modal-provider.ts:99',
    owner: () => sdk().modalClient,
    key: 'sandboxes',
    kind: 'data',
  },
  {
    driverCall: 'client.sandboxes.create(app, image, { timeoutMs, encryptedPorts })',
    source: 'createSandbox, modal-provider.ts:118',
    owner: () => sdk().modalClient.sandboxes,
    key: 'create',
    kind: 'method',
  },
  {
    driverCall: 'client.sandboxes.fromId(sandboxId)',
    source: 'reconnectLive, modal-provider.ts:192',
    owner: () => sdk().modalClient.sandboxes,
    key: 'fromId',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.sandboxId',
    source: 'createSandbox, modal-provider.ts:103',
    owner: () => sdk().modalSandbox,
    key: 'sandboxId',
    kind: 'data',
  },
  {
    driverCall: "sandbox.exec(['sh', '-c', command])",
    source: 'runCommandLive, modal-provider.ts:126',
    owner: () => sdk().modalSandbox,
    key: 'exec',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.terminate()',
    source: 'terminateLive, modal-provider.ts:157',
    owner: () => sdk().modalSandbox,
    key: 'terminate',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.tunnels',
    source: 'createSandbox, modal-provider.ts:104',
    owner: () => sdk().modalSandbox,
    key: 'tunnels',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.filesystem',
    source: 'writeFileLive / readFileLive, modal-provider.ts',
    owner: () => sdk().modalSandbox,
    key: 'filesystem',
    kind: 'getter',
  },
  {
    driverCall: 'sandbox.filesystem.writeText(content, absolutePath)',
    source: 'writeFileLive, modal-provider.ts',
    owner: () => sdk().modalSandbox.filesystem,
    key: 'writeText',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.filesystem.readText(absolutePath)',
    source: 'readFileLive, modal-provider.ts',
    owner: () => sdk().modalSandbox.filesystem,
    key: 'readText',
    kind: 'method',
  },
]);

describe('modal call shapes', () => {
  it('apps.fromName takes a name, images.fromRegistry a tag, sandboxes.create an app and an image', () => {
    expect(arityOf(sdk().modalClient.apps, 'fromName')).toBe(1);
    expect(arityOf(sdk().modalClient.images, 'fromRegistry')).toBe(2);
    expect(arityOf(sdk().modalClient.sandboxes, 'create')).toBe(2);
    expect(arityOf(sdk().modalClient.sandboxes, 'fromId')).toBe(1);
  });

  it('exec takes a command array plus options and terminate takes an options bag', () => {
    expect(arityOf(sdk().modalSandbox, 'exec')).toBe(2);
    expect(arityOf(sdk().modalSandbox, 'terminate')).toBe(1);
  });

  it('filesystem.writeText takes UTF-8 text then an absolute path; readText takes a path', () => {
    expect(arityOf(sdk().modalSandbox.filesystem, 'writeText')).toBe(2);
    expect(arityOf(sdk().modalSandbox.filesystem, 'readText')).toBe(1);
    type WriteText = InstanceType<ModalModule['Sandbox']>['filesystem']['writeText'];
    const writeText: WriteText = async (_data: string, _remotePath: string) => undefined;
    expect(typeof writeText).toBe('function');
  });

  it('apps.fromName still accepts createIfMissing and sandboxes.create still accepts timeoutMs plus encryptedPorts', () => {
    type Apps = InstanceType<ModalModule['ModalClient']>['apps'];
    type Sandboxes = InstanceType<ModalModule['ModalClient']>['sandboxes'];
    const fromName: NonNullable<Parameters<Apps['fromName']>[1]> = { createIfMissing: true };
    const create: NonNullable<Parameters<Sandboxes['create']>[2]> = {
      timeoutMs: 5 * 60 * 1000,
      encryptedPorts: [5173],
    };
    expect(fromName.createIfMissing).toBe(true);
    expect(create.timeoutMs).toBe(300_000);
    expect(create.encryptedPorts).toEqual([5173]);
  });

  it('Tunnel still exposes the url the driver reads', () => {
    type Tunnels = Awaited<ReturnType<InstanceType<ModalModule['Sandbox']>['tunnels']>>;
    const exposesUrl = true satisfies ('url' extends keyof Tunnels[number] ? true : false);
    expect(exposesUrl).toBe(true);
  });

  /**
   * `tunnels` is a method — `tunnels(timeoutMs?): Promise<Record<number, Tunnel>>` —
   * keyed by the container port. A tunnel only exists for a port listed in
   * `SandboxCreateParams.encryptedPorts` (or h2Ports / unencryptedPorts) at create.
   * Asserted as a fact about the SDK so a `.get` object shape would fail here.
   */
  it('Sandbox#tunnels is a method with no .get, and create params still name encryptedPorts', () => {
    const tunnels = readMember(sdk().modalSandbox, 'tunnels');
    expect(typeof tunnels).toBe('function');
    expect(readMember(tunnels as object, 'get')).toBeUndefined();

    type Sandboxes = InstanceType<ModalModule['ModalClient']>['sandboxes'];
    type CreateParams = NonNullable<Parameters<Sandboxes['create']>[2]>;
    const hasEncryptedPorts = true satisfies ('encryptedPorts' extends keyof CreateParams ? true : false);
    expect(hasEncryptedPorts).toBe(true);
  });

  /**
   * The driver reads stdout/stderr via `readText()` and the exit code from `wait()`.
   * Pin that the installed SDK still returns a ContainerProcess — not a
   * `{ stdout, stderr, exitCode }` record — so that mapping cannot silently regress.
   */
  it('exec still resolves to a ContainerProcess with wait(); the driver reads streams and wait()', () => {
    const containerProcess = sdk().modalModule.ContainerProcess.prototype;
    expect(memberKind(containerProcess, 'wait')).toBe('method');
    expect(memberKind(containerProcess, 'exitCode')).toBe('missing');

    type Exec = Awaited<ReturnType<InstanceType<ModalModule['Sandbox']>['exec']>>;
    const execExposesExitCode = false satisfies ('exitCode' extends keyof Exec ? true : false);
    expect(execExposesExitCode).toBe(false);
  });

  /** The driver reads `sandbox.sandboxId`. `objectId` is not on the installed SDK. */
  it('Sandbox still exposes sandboxId and not objectId', () => {
    expect(memberKind(sdk().modalSandbox, 'objectId')).toBe('missing');
    const exposesObjectId = false satisfies ('objectId' extends keyof InstanceType<
      ModalModule['Sandbox']
    >
      ? true
      : false);
    expect(exposesObjectId).toBe(false);
  });
});

// --- Daytona -----------------------------------------------------------------------

pinSuite('lib/sandbox/providers/daytona-provider.ts against @daytona/sdk', [
  {
    driverCall: "(await import('@daytona/sdk')).Daytona",
    source: 'loadDaytonaSdk, daytona-provider.ts:173',
    owner: () => sdk().daytonaModule,
    key: 'Daytona',
    kind: 'constructor',
  },
  {
    driverCall: 'client.create({ language, public, autoStopInterval })',
    source: 'createSandbox, daytona-provider.ts:77',
    owner: () => sdk().daytonaClient,
    key: 'create',
    kind: 'method',
  },
  {
    driverCall: 'client.get(sandboxId)',
    source: 'reconnectLive, daytona-provider.ts:167',
    owner: () => sdk().daytonaClient,
    key: 'get',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.id',
    source: 'createSandbox, daytona-provider.ts:82',
    owner: () => daytonaSandboxProbe(),
    key: 'id',
    kind: 'data',
  },
  {
    driverCall: 'sandbox.process',
    source: 'runCommandLive, daytona-provider.ts:98',
    owner: () => daytonaSandboxProbe(),
    key: 'process',
    kind: 'data',
  },
  {
    driverCall: 'sandbox.process.executeCommand(command)',
    source: 'runCommandLive, daytona-provider.ts:99',
    owner: () => daytonaSandboxProbe().process,
    key: 'executeCommand',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.fs',
    source: 'writeFileLive, daytona-provider.ts:111',
    owner: () => daytonaSandboxProbe(),
    key: 'fs',
    kind: 'data',
  },
  {
    driverCall: 'sandbox.fs.uploadFile(Buffer.from(content), path)',
    source: 'writeFileLive, daytona-provider.ts:112',
    owner: () => daytonaSandboxProbe().fs,
    key: 'uploadFile',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.fs.downloadFile(path)',
    source: 'readFileLive, daytona-provider.ts:120',
    owner: () => daytonaSandboxProbe().fs,
    key: 'downloadFile',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.fs.listFiles(directory)',
    source: 'listFilesLive, daytona-provider.ts:129',
    owner: () => daytonaSandboxProbe().fs,
    key: 'listFiles',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.getPreviewLink(5173)',
    source: 'createSandbox and reconnectLive, daytona-provider.ts:101 and :169',
    owner: () => daytonaSandboxProbe(),
    key: 'getPreviewLink',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.delete()',
    source: 'terminateLive, daytona-provider.ts:140',
    owner: () => daytonaSandboxProbe(),
    key: 'delete',
    kind: 'method',
  },
  {
    driverCall: 'sandbox.stop()',
    source: 'terminateLive, daytona-provider.ts:141',
    owner: () => daytonaSandboxProbe(),
    key: 'stop',
    kind: 'method',
  },
]);

describe('@daytona/sdk call shapes', () => {
  it('sandbox.fs and sandbox.process are the exported FileSystem and Process classes', () => {
    expect(daytonaSandboxProbe().fs).toBeInstanceOf(sdk().daytonaModule.FileSystem);
    expect(daytonaSandboxProbe().process).toBeInstanceOf(sdk().daytonaModule.Process);
  });

  it('the constructor still takes apiKey and apiUrl', () => {
    type Config = NonNullable<ConstructorParameters<DaytonaModule['Daytona']>[0]>;
    const config: Config = { apiKey: 'surface-check', apiUrl: 'https://sandbox.invalid' };
    expect(config.apiUrl).toBe('https://sandbox.invalid');
  });

  /**
   * `create`, `downloadFile` and `uploadFile` are all overloaded, so `Parameters<>` and
   * `ReturnType<>` resolve to the last signature rather than the one the driver hits.
   * Assigning the real client to the shape `daytona-provider.ts` needs picks the right
   * overload and fails to compile if that overload goes away.
   */
  it('the client still offers the create and get calls the driver makes', () => {
    const client: {
      create(params: { language: string; public: boolean; autoStopInterval: number }): Promise<unknown>;
      get(sandboxId: string): Promise<unknown>;
    } = sdk().daytonaClient;
    expect(typeof client.create).toBe('function');
    expect(typeof client.get).toBe('function');
  });

  it('the sandbox still offers the id, preview link and teardown calls the driver makes', () => {
    const sandbox: {
      id: string;
      getPreviewLink(port: number): Promise<{ url: string }>;
      delete(): Promise<void>;
      stop(): Promise<void>;
    } = daytonaSandboxProbe();
    expect(sandbox.id).toBe('surface-check-never-created');
  });

  it('the sandbox filesystem still offers the upload, download and list calls the driver makes', () => {
    const files: {
      uploadFile(file: Buffer, remotePath: string): Promise<void>;
      downloadFile(remotePath: string): Promise<Buffer>;
      listFiles(path: string): Promise<Array<{ name: string }>>;
    } = daytonaSandboxProbe().fs;
    expect(typeof files.uploadFile).toBe('function');
    expect(typeof files.downloadFile).toBe('function');
    expect(typeof files.listFiles).toBe('function');
  });

  it('executeCommand resolves to result plus an optional exitCode, and carries no stderr', () => {
    type ExecuteResponse = Awaited<
      ReturnType<InstanceType<DaytonaModule['Process']>['executeCommand']>
    >;
    const hasResult = true satisfies ('result' extends keyof ExecuteResponse ? true : false);
    const hasExitCode = true satisfies ('exitCode' extends keyof ExecuteResponse ? true : false);
    // daytona-provider.ts:30 declares executeCommand result without stderr; :104 reads result.stderr.
    // The installed SDK never sets it, so Daytona stderr is always the empty string.
    const hasStderr = false satisfies ('stderr' extends keyof ExecuteResponse ? true : false);
    expect([hasResult, hasExitCode, hasStderr]).toEqual([true, true, false]);
  });

});
