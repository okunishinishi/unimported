import fs, { existsSync } from 'fs';
import path from 'path';
import util from 'util';
import cases from 'jest-in-case';
import simpleGit from 'simple-git';
import { main, CliArguments } from '..';
import { purgeCache } from '../cache';

import FileEntryCache from 'file-entry-cache';
import { __clearCachedConfig } from '../config';

const mkdir = util.promisify(fs.mkdir);
const rmdir = util.promisify(fs.rm);
const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);

afterAll(() => {
  fs.rmSync('.test-space', { recursive: true });
});

jest.mock('simple-git');

jest.mock('file-entry-cache', () => {
  const actual = jest.requireActual('file-entry-cache');
  let mockedCache: FileEntryCache.FileEntryCache;
  return {
    get mockedCache() {
      return mockedCache;
    },
    create(...args) {
      mockedCache = actual.create(...args);
      mockedCache.removeEntry = jest.fn(mockedCache.removeEntry);
      return mockedCache;
    },
  };
});

async function exec(
  testProjectDir: string,
  {
    init = false,
    flow = false,
    update = false,
    ignoreUntracked = false,
    cache = true,
    clearCache = false,
  }: Partial<CliArguments> = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const originalExit = process.exit;
  const originalCwd = process.cwd();
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  try {
    let exitCode: number | null = null;
    let stdout = '';
    let stderr = '';

    const appendStdout = (...args: any[]): void => {
      stdout += args.map((arg) => arg.toString()).join(' ');
    };

    const appendStderr = (...args: any[]): void => {
      stderr += args.map((arg) => arg.toString()).join(' ');
    };

    console.log = appendStdout;
    console.warn = appendStdout;
    console.error = appendStderr;

    process.exit = (code: number): never => {
      exitCode = exitCode ?? code;
      return undefined as never;
    };

    process.chdir(testProjectDir);

    await main({
      init,
      flow,
      update,
      ignoreUntracked,
      cache,
      clearCache,
    });

    return { exitCode: exitCode ?? 0, stdout, stderr };
  } finally {
    process.chdir(originalCwd);
    process.exit = originalExit;
    Object.entries(originalConsole).forEach(([key, value]) => {
      console[key] = value;
    });
  }
}

async function createProject(
  files: Array<{ name: string; content: string }>,
  baseDir = '.',
  name?: string,
): Promise<string> {
  const randomId = Math.floor(Math.random() * 1000000);

  const testSpaceDir = path.join('.test-space', randomId.toString());

  await mkdir(testSpaceDir, { recursive: true });

  if (name) {
    fs.writeFileSync(path.join(testSpaceDir, '.scenario'), name);
  }

  await Promise.all(
    files.map((file) =>
      mkdir(path.join(testSpaceDir, path.dirname(file.name)), {
        recursive: true,
      }),
    ),
  );

  await Promise.all(
    files.map((file) =>
      writeFile(path.join(testSpaceDir, file.name), file.content),
    ),
  );

  return path.join(testSpaceDir, baseDir);
}

beforeEach(() => {
  __clearCachedConfig();
  purgeCache();
});

cases(
  'cli integration tests',
  async (scenario) => {
    const testProjectDir = await createProject(
      scenario.files,
      scenario.baseDir,
      scenario.name,
    );

    try {
      if (scenario.ignoreUntracked) {
        const status = jest.fn(async () => {
          return { not_added: scenario.untracked };
        });
        (simpleGit as jest.Mock).mockImplementationOnce(() => {
          return {
            status,
          };
        });
      }

      let { stdout, stderr, exitCode } = await exec(testProjectDir, {
        ignoreUntracked: scenario.ignoreUntracked,
      });

      expect(stdout).toMatch(scenario.stdout || '');
      expect(stderr).toMatch(scenario.stderr || '');
      expect(exitCode).toBe(scenario.exitCode);

      // Exec again to test cache primed case
      if (scenario.ignoreUntracked) {
        const status = jest.fn(async () => {
          return { not_added: scenario.untracked };
        });
        (simpleGit as jest.Mock).mockImplementationOnce(() => {
          return {
            status,
          };
        });
      }

      ({ stdout, stderr, exitCode } = await exec(testProjectDir, {
        ignoreUntracked: scenario.ignoreUntracked,
      }));

      expect(stdout).toMatch(scenario.stdout || '');
      expect(stderr).toMatch(scenario.stderr || '');
      expect(exitCode).toBe(scenario.exitCode);
    } finally {
      await rmdir(testProjectDir, { recursive: true });
    }
  },
  [
    {
      name: 'logs an error message when package.json cannot be located',
      files: [{ name: 'index.js', content: '' }],
      exitCode: 1,
      stderr: /could not resolve package.json, are you in a node project\?/s,
    },
    {
      name: 'should identify unimported file',
      files: [
        { name: 'package.json', content: '{ "main": "index.js" }' },
        { name: 'index.js', content: `import foo from './foo';` },
        { name: 'foo.js', content: '' },
        { name: 'bar.js', content: '' },
      ],
      exitCode: 1,
      stdout: /1 unimported files.*bar.js/s,
    },
    {
      name: 'should identify unresolved imports',
      files: [
        { name: 'package.json', content: '{ "main": "index.js" }' },
        { name: 'index.js', content: `import foo from './foo';` },
      ],
      exitCode: 1,
      stdout: /1 unresolved imports.*.\/foo/s,
    },
    {
      name: 'should ignore untracked files that are not imported',
      files: [
        { name: 'package.json', content: '{ "main": "index.js" }' },
        { name: 'index.js', content: `import foo from './foo';` },
        { name: 'foo.js', content: '' },
        { name: 'bar.js', content: '' },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./,
      ignoreUntracked: true,
      untracked: ['bar.js'],
    },
    {
      name: 'should identify unimported file in meteor project',
      files: [
        {
          name: 'package.json',
          content:
            '{ "meteor" : { "mainModule": { "client": "client.js", "server": "server.js" } } }',
        },
        { name: 'client.js', content: `import foo from './foo';` },
        { name: 'server.js', content: '' },
        { name: '.meteor/release', content: '' },
        { name: 'foo.js', content: '' },
        { name: 'bar.js', content: '' },
      ],
      exitCode: 1,
      stdout: /1 unimported files.*bar.js/s,
    },
    {
      name: 'should work for vue files',
      files: [
        { name: 'package.json', content: '{ "main" : "index.js" }' },
        { name: 'index.js', content: `import foo from './app.vue';` },
        {
          name: 'app.vue',
          content: `
            <template><div>html</div></template>
            <script>
               import { util } from './util.js';
            </script>
        `,
        },
        { name: 'util.js', content: '' },
        { name: 'dangling.js', content: '' },
        {
          name: '.unimportedrc.json',
          content: '{ "extensions": [".js", ".vue"] }',
        },
      ],
      exitCode: 1,
      stdout: /1 unimported files.*dangling.js/s,
    },
    {
      name: 'Invalid json',
      files: [
        {
          name: '.unimportedrc.json',
          content: '{ "entry": ["index.js"} }',
        },
      ],
      exitCode: 1,
      stdout: '',
    },
    {
      name: 'next project',
      files: [
        {
          name: '.next/test.json',
          content: '{ "entry": ["index.js"] }',
        },
        {
          name: 'package.json',
          content:
            '{ "main": "index.js", "dependencies": { "@test/dependency": "1.0.0" } }',
        },
        { name: 'index.js', content: `import foo from './foo';` },
        { name: 'foo.js', content: '' },
      ],
      exitCode: 1,
      stdout: /1 unused dependencies.*@test\/dependency/s,
    },
    {
      name: 'should identify unused dependencies',
      files: [
        {
          name: 'package.json',
          content:
            '{ "main": "index.js", "dependencies": { "@test/dependency": "1.0.0" } }',
        },
        { name: 'index.js', content: `import foo from './foo';` },
        { name: 'foo.js', content: '' },
      ],
      exitCode: 1,
      stdout: /1 unused dependencies.*@test\/dependency/s,
    },
    {
      name: 'should not report issues when everything is used',
      files: [
        {
          name: 'package.json',
          content:
            '{ "main": "index.js", "dependencies": { "@test/dependency": "1.0.0" } }',
        },
        {
          name: 'index.js',
          content: `
import foo from './foo';
import bar from './bar';
`,
        },
        { name: 'foo.js', content: '' },
        { name: 'bar.js', content: 'import test from "@test/dependency"' },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./,
    },
    {
      name: 'should not report entry file loaded from config, as missing',
      files: [
        { name: 'package.json', content: '{}' },
        {
          name: '.unimportedrc.json',
          content: '{ "entry": ["index.js"] }',
        },
        {
          name: 'index.js',
          content: `import a from './a'`,
        },
        {
          name: 'a.js',
          content: `export default null`,
        },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files/,
    },
    {
      name: 'should use all variants of import/export',
      files: [
        {
          name: 'package.json',
          content: '{ "main": "index.js" }',
        },
        {
          name: 'index.js',
          content: `import a from './a'`,
        },
        {
          name: 'a.js',
          content: `
import {b as a} from './b'
const promise = import('./d')
const templatePromise = import(\`./e\`)
export {a}
export {b} from './b'
export * from './c'
export default promise
`,
        },
        { name: 'b.js', content: 'export const b = 2;' },
        { name: 'c.js', content: 'const c = 3; export {c}' },
        { name: 'd.js', content: 'export default 42' },
        { name: 'e.js', content: 'export default 42' },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./,
    },
    {
      name: 'should identify ts paths imports',
      files: [
        { name: 'package.json', content: '{ "main": "index.ts" }' },
        { name: 'index.ts', content: `import foo from '@root/foo';` },
        {
          name: 'foo.ts',
          content: `
            class Foo extends Bar {
              override baz() {}
            }
          `,
        },
        { name: 'bar.ts', content: '' },
        {
          name: 'tsconfig.json',
          content: '{ "compilerOptions": { "paths": { "@root": ["."] } } }',
        },
      ],
      exitCode: 1,
      stdout: /1 unimported files.*bar.ts/s,
    },
    {
      name: 'should identify config alias imports',
      files: [
        { name: 'package.json', content: '{ "main": "index.ts" }' },
        { name: 'index.ts', content: `import foo from '@root/foo';` },
        { name: 'foo.ts', content: '' },
        { name: 'bar.ts', content: '' },
        {
          name: '.unimportedrc.json',
          content: '{ "aliases": { "@root": ["."] }, "rootDir": "/" }',
        },
      ],
      exitCode: 1,
      stdout: /1 unimported files.*bar.ts/s,
    },
    {
      name: 'should identify alias index imports',
      files: [
        { name: 'package.json', content: '{ "main": "index.ts" }' },
        { name: 'index.ts', content: `import { random } from '@helpers';` },
        { name: 'helpers/index.ts', content: '' },
        {
          name: '.unimportedrc.json',
          content: '{ "aliases": { "@helpers": ["./helpers"] } }',
        },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./,
    },
    {
      name: 'should identify alias file imports',
      files: [
        { name: 'package.json', content: '{ "main": "index.ts" }' },
        { name: 'index.ts', content: `import { random } from '@random';` },
        { name: 'helpers/random.ts', content: '' },
        {
          name: '.unimportedrc.json',
          content: '{ "aliases": { "@random": ["./helpers/random"] } }',
        },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./,
    },
    {
      name: 'should identify monorepo-type sibling modules',
      baseDir: 'packages/A',
      files: [
        {
          name: 'packages/A/package.json',
          content:
            '{ "main": "index.js", "repository": { "directory": "path/goes/here" } }',
        },
        {
          name: 'packages/A/index.js',
          content: `import foo from 'B/foo';`,
        },
        { name: 'packages/B/foo.js', content: '' },
        { name: 'packages/C/bar.js', content: '' },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./,
    },
    {
      name: 'should support rootDir config',
      files: [
        { name: 'package.json', content: '{ "main": "src/index.ts" }' },
        { name: 'src/index.ts', content: `import '/nested';` },
        {
          name: 'src/nested/index.ts',
          content: `import foo from '/nested/foo';`,
        },
        { name: 'src/nested/foo.ts', content: '' },
        { name: 'src/nested/bar.ts', content: '' },
        {
          name: '.unimportedrc.json',
          content: '{ "rootDir": "src" }',
        },
      ],
      exitCode: 1,
      stdout: /1 unimported files.*bar.ts/s,
    },
    {
      name: 'should support root slash import',
      files: [
        { name: 'package.json', content: '{ "main": "index.js" }' },
        { name: 'index.js', content: `import foo from '/foo';` },
        { name: 'foo/index.js', content: `import bar from '/bar';` },
        { name: 'bar.js', content: '' },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./s,
    },
    {
      name: 'should support root slash import in meteor project',
      files: [
        {
          name: 'package.json',
          content:
            '{ "meteor" : { "mainModule": { "client": "client.js", "server": "server.js" } } }',
        },
        { name: 'client.js', content: `import foo from '/foo';` },
        { name: 'server.js', content: '' },
        { name: '.meteor/release', content: '' },
        { name: 'foo.js', content: '' },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./s,
    },
    {
      name: 'should support type imports for typescript projects',
      files: [
        { name: 'package.json', content: '{ "main": "index.ts" }' },
        {
          name: 'index.ts',
          content: `import foo from './foo'; import type { Bar } from './bar'`,
        },
        { name: 'foo.ts', content: '' },
        { name: 'bar.ts', content: '' },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./s,
    },
    {
      name: 'should report parse failure for invalid file',
      files: [
        { name: 'package.json', content: '{ "main": "index.js" }' },
        { name: 'index.js', content: `not valid` },
      ],
      exitCode: 1,
      stderr: /Failed parsing.*\/index.js/s,
    },
    {
      name: 'should ignore non import/require paths',
      files: [
        { name: 'package.json', content: '{ "main": "index.js" }' },
        {
          name: 'index.js',
          content: `import fs from 'fs'; const dependency = fs.readFileSync('some_path.js');`,
        },
      ],
      exitCode: 0,
      stdout: '',
    },
    {
      name: 'should not report unimported file which is in ignore file',
      files: [
        { name: 'package.json', content: '{ "main": "index.js" }' },
        { name: 'index.js', content: `import foo from './foo';` },
        {
          name: '.unimportedrc.json',
          content: '{"ignoreUnimported": ["bar.js"]}',
        },
        { name: 'foo.js', content: '' },
        { name: 'bar.js', content: '' },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./s,
    },
    {
      name: 'should not report unused dependency which is in ignore file',
      files: [
        {
          name: 'package.json',
          content:
            '{ "main": "index.js", "dependencies": { "@test/dependency": "1.0.0" } }',
        },
        { name: 'index.js', content: `import foo from './foo';` },
        {
          name: '.unimportedrc.json',
          content: '{"ignoreUnused": ["@test/dependency"]}',
        },
        { name: 'foo.js', content: '' },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./s,
    },
    {
      name: 'should not report unresolved import which is in ignore file',
      files: [
        {
          name: 'package.json',
          content: '{ "main": "index.js"  }',
        },
        { name: 'index.js', content: `import foo from './foo';` },
        {
          name: '.unimportedrc.json',
          content: '{"ignoreUnresolved": ["./foo"]}',
        },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./s,
    },
    {
      name: 'should not report entry file as missing',
      files: [
        {
          name: 'package.json',
          content: '{ "main": "index.js"  }',
        },
      ],
      exitCode: 1,
      stdout: '',
    },
    {
      name: 'can work with glob patterns in config file',
      files: [
        { name: 'package.json', content: '{}' },
        {
          name: '.unimportedrc.json',
          content: `{
            "entry": ["src/index.tsx", "src/**/*.test.{j,t}s"],
            "ignoreUnresolved": [],
            "ignoreUnimported": ["src/setup{Proxy,Tests}.js"],
            "ignoreUnused": [],
            "ignorePatterns": ["**/node_modules/**", "**/*.d.ts"]
          }`,
        },
        { name: 'src/index.tsx', content: `import './imported';` },
        { name: 'src/imported.ts', content: 'export default null;' },
        {
          name: 'src/__tests__/imported.test.js',
          content: `import proxy from '../setupProxy'`,
        },
        { name: 'src/setupProxy.js', content: '' },
        { name: 'src/setupTests.js', content: '' },
        { name: 'node_module/module/lib.js', content: '' },
        { name: 'src/global.d.ts', content: '' },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./s,
    },
    {
      name: 'supports alias overrides per entry point',
      files: [
        { name: 'package.json', content: '{}' },
        {
          name: '.unimportedrc.json',
          content: `{
          "entry": [{
              "file": "src/entry-client.js",
              "extend": { "aliases": { "create-api": ["./src/api/create-api-client"] } }
            }, {
              "file": "src/entry-server.js",
              "extend": { "aliases": { "create-api": ["./src/api/create-api-server"] } }
            }],
          "extensions": [".js"],
          "aliases": { "create-api": ["./src/api/create-api-server"] }
        }`,
        },
        { name: 'src/entry-client.js', content: `import 'create-api';` },
        { name: 'src/entry-server.js', content: `import 'create-api';` },
        { name: 'src/api/create-api-client.js', content: `` },
        { name: 'src/api/create-api-server.js', content: `` },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./s,
    },
    {
      name: 'supports extension overrides per entry point',
      files: [
        {
          name: 'package.json',
          content:
            '{ "dependencies": { "@test/client": "1", "@test/server": "1" } }',
        },
        {
          name: '.unimportedrc.json',
          content: `{
          "entry": [{
              "file": "src/entry.js",
              "label": "client",
              "extend": { "extensions": [".client.js"] }
            }, {
              "file": "src/entry.js",
              "label": "server",
              "extend": { "extensions": [".server.js"] }
            }],
          "extensions": [".js"]
        }`,
        },
        { name: 'src/entry.js', content: `import './config';` },
        {
          name: 'src/config.client.js',
          content: `
            import '@test/client';
            import './client-only'; 
            import './shared';
          `,
        },
        {
          name: 'src/config.server.js',
          content: `
            import '@test/server';
            import './server-only'; 
            import './shared';
          `,
        },
        { name: 'src/shared.js', content: '' },
        { name: 'src/client-only.js', content: '' },
        { name: 'src/server-only.js', content: '' },
      ],
      exitCode: 0,
      stdout: /There don't seem to be any unimported files./s,
    },
  ],
);

// ----------------------------------------------------------------------------

cases(
  'cli integration tests with update option',
  async (scenario) => {
    const testProjectDir = await createProject(scenario.files);
    const outputFile = path.join(testProjectDir, '.unimportedrc.json');

    try {
      const { exitCode } = await exec(testProjectDir, { update: true });

      const outputFileContent = JSON.parse(await readFile(outputFile, 'utf-8'));
      expect(scenario.output).toEqual(outputFileContent);
      expect(exitCode).toBe(scenario.exitCode);
    } finally {
      await rmdir(testProjectDir, { recursive: true });
    }
  },
  [
    {
      name: 'should identify unimported file',
      files: [
        { name: 'package.json', content: '{ "main": "index.js" }' },
        { name: 'index.js', content: `import foo from './foo';` },
        { name: 'foo.js', content: '' },
        { name: 'bar.js', content: '' },
      ],
      exitCode: 0,
      output: {
        ignoreUnresolved: [],
        ignoreUnimported: ['bar.js'],
        ignoreUnused: [],
      },
    },
    {
      name: 'should identify unused dependencies',
      files: [
        {
          name: 'package.json',
          content:
            '{ "main": "index.js", "dependencies": { "@test/dependency": "1.0.0" } }',
        },
        { name: 'index.js', content: `import foo from './foo';` },
        { name: 'foo.js', content: '' },
      ],
      exitCode: 0,
      output: {
        ignoreUnresolved: [],
        ignoreUnimported: [],
        ignoreUnused: ['@test/dependency'],
      },
    },
    {
      name: 'should not ignore anything when everything is used',
      files: [
        {
          name: 'package.json',
          content:
            '{ "main": "index.js", "dependencies": { "@test/dependency": "1.0.0" } }',
        },
        {
          name: 'index.js',
          content: `
import foo from './foo';
import bar from './bar';
`,
        },
        { name: 'foo.js', content: '' },
        { name: 'bar.js', content: 'import test from "@test/dependency"' },
      ],
      exitCode: 0,
      output: {
        ignoreUnresolved: [],
        ignoreUnimported: [],
        ignoreUnused: [],
      },
    },
  ],
);

// ----------------------------------------------------------------------------

cases(
  'cli integration tests with init option',
  async (scenario) => {
    const testProjectDir = await createProject(scenario.files);
    const outputFile = path.join(testProjectDir, '.unimportedrc.json');

    try {
      const { exitCode } = await exec(testProjectDir, { init: true });

      const outputFileContent = JSON.parse(await readFile(outputFile, 'utf-8'));
      expect(scenario.output).toEqual(outputFileContent);
      expect(exitCode).toBe(scenario.exitCode);
    } finally {
      await rmdir(testProjectDir, { recursive: true });
    }
  },
  [
    {
      name: 'should create default ignore file',
      files: [
        { name: 'package.json', content: '{}' },
        { name: 'index.js', content: '' },
      ],
      exitCode: 0,
      output: {
        ignorePatterns: [
          '**/node_modules/**',
          '**/*.stories.{js,jsx,ts,tsx}',
          '**/*.tests.{js,jsx,ts,tsx}',
          '**/*.test.{js,jsx,ts,tsx}',
          '**/*.spec.{js,jsx,ts,tsx}',
          '**/tests/**',
          '**/__tests__/**',
          '**/*.d.ts',
        ],
        ignoreUnresolved: [],
        ignoreUnimported: [],
        ignoreUnused: [],
      },
    },
    {
      name: 'should create expected ignore file for meteor project',
      files: [
        {
          name: 'package.json',
          content:
            '{ "meteor": { "mainModule": { "client": "", "server": "" } } }',
        },
        {
          name: '.meteor',
          content: '',
        },
      ],
      exitCode: 0,
      output: {
        ignorePatterns: [
          '**/node_modules/**',
          '**/*.stories.{js,jsx,ts,tsx}',
          '**/*.tests.{js,jsx,ts,tsx}',
          '**/*.test.{js,jsx,ts,tsx}',
          '**/*.spec.{js,jsx,ts,tsx}',
          '**/tests/**',
          '**/__tests__/**',
          '**/*.d.ts',
          'packages/**',
          'public/**',
          'private/**',
          'tests/**',
        ],
        ignoreUnresolved: [],
        ignoreUnimported: [],
        ignoreUnused: [],
      },
    },
  ],
);

cases(
  'cli integration tests with clear-cache option',
  async (scenario) => {
    const testProjectDir = await createProject(scenario.files);
    const cachePath = path.resolve(
      testProjectDir,
      './node_modules/.cache/unimported',
    );

    try {
      const { exitCode, stdout } = await exec(testProjectDir, {
        clearCache: true,
      });

      const cacheExists = existsSync(cachePath);
      expect(exitCode).toBe(scenario.exitCode);
      expect(stdout).toBe(scenario.stdout);
      expect(cacheExists).toBe(false);
    } finally {
      await rmdir(testProjectDir, { recursive: true });
    }
  },
  [
    {
      name: 'should remove cache and exit silently',
      files: [
        { name: 'package.json', content: '{}' },
        { name: 'index.js', content: '' },
        { name: 'node_modules/.cache/unimported/cache-1', content: '' },
      ],
      exitCode: 0,
      stdout: '',
    },
  ],
);

describe('cache', () => {
  const files = [
    { name: 'package.json', content: '{ "main": "index.js" }' },
    {
      name: 'index.js',
      content: `
import foo from './foo';
import bar from './bar';
`,
    },
    { name: 'foo.js', content: 'import bar from "./bar"' },
    { name: 'bar.js', content: '' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should invalidate the cache on parse error', async () => {
    const testProjectDir = await createProject(files);

    try {
      let { stdout, stderr, exitCode } = await exec(testProjectDir);

      expect(stdout).toMatch(/There don't seem to be any unimported files./);
      expect(stderr).toMatch('');
      expect(exitCode).toBe(0);

      fs.unlinkSync(path.join(testProjectDir, 'bar.js'));

      ({ stdout, stderr, exitCode } = await exec(testProjectDir, {}));

      expect(stdout).toMatch(/1 unresolved imports.*.\/bar/s);
      expect(stderr).toMatch('');
      expect(exitCode).toBe(1);

      expect(
        (FileEntryCache as any).mockedCache.removeEntry.mock.calls.map(
          ([filePath]) => path.basename(filePath),
        ),
      ).toMatchInlineSnapshot(`
        Array [
          "bar.js",
          "bar.js",
          "index.js",
          "foo.js",
          "foo.js",
          "index.js",
        ]
      `);
    } finally {
      await rmdir(testProjectDir, { recursive: true });
    }
  });

  it('should recover from extension rename', async () => {
    const testProjectDir = await createProject(files);

    try {
      let { stdout, stderr, exitCode } = await exec(testProjectDir);

      expect(stdout).toMatch(/There don't seem to be any unimported files./);
      expect(stderr).toMatch('');
      expect(exitCode).toBe(0);

      fs.renameSync(
        path.join(testProjectDir, 'bar.js'),
        path.join(testProjectDir, 'bar.ts'),
      );

      ({ stdout, stderr, exitCode } = await exec(testProjectDir, {}));

      expect(stdout).toMatch(/There don't seem to be any unimported files./);
      expect(stderr).toMatch('');
      expect(exitCode).toBe(0);

      expect(
        (FileEntryCache as any).mockedCache.removeEntry.mock.calls.map(
          ([filePath]) => path.basename(filePath),
        ),
      ).toMatchInlineSnapshot(`
        Array [
          "bar.js",
          "bar.js",
          "index.js",
          "foo.js",
          "foo.js",
          "index.js",
        ]
      `);
    } finally {
      await rmdir(testProjectDir, { recursive: true });
    }
  });
});
