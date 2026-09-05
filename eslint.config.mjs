import path from 'node:path';
import { builtinRules } from 'eslint/use-at-your-own-risk';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Memory note in backend-brief.md §B: these DI closures deliberately keep their
// injected dependencies together; do not split create*/register*/install* factories.
// Limits apply only to the named function, so other functions still stop at 120.
const functionBaselines = {
  'src/electron/archiveRecovery.ts': { createArchiveRecovery: 400 }, // recovery DI closure (369)
  'src/electron/ocrRerun.ts': { createOcrRerun: 350 }, // OCR transaction DI closure (308)
  'src/electron/openPolicy.ts': { createOpenPolicy: 500 }, // open-policy DI closure (491)
  'src/electron/pathPolicy.ts': { createPathPolicy: 300 }, // path-policy DI closure (261)
  'src/electron/resetService.ts': { createResetService: 300 }, // reset DI closure (289)
  'src/electron/ipc/mailHandlers.ts': { registerMailHandlers: 250 }, // mail IPC DI closure (241)
  'src/electron/ipc/operationHandlers.ts': { registerOperationHandlers: 900 }, // operation IPC DI closure (882)
  'src/electron/operationSupport.ts': { createOperationSupport: 200 }, // operation DI closure (169)
  'src/electron/summaryFacade.ts': { createSummaryFacade: 150 }, // summary DI closure (149)
  // installLifecycle and createWindowSecurity are below 120 after skipping comments/blanks.
  'src/extract/attachment.ts': { extract: 150 }, // existing attachment traversal needs a separate structural refactor (133)
  'src/electron/summary.ts': { summarizeLibrary: 150 }, // newly landed summary is reserved for separate review (133)
};

const functionLines = builtinRules.get('max-lines-per-function');
const baselinePlugin = {
  rules: {
    'max-lines-per-function': {
      ...functionLines,
      create(context) {
        const filename = path.relative(import.meta.dirname, context.filename).split(path.sep).join('/');
        const limits = functionBaselines[filename] ?? {};
        return functionLines.create(Object.create(context, {
          report: { value(problem) {
            const name = problem.data.name.match(/'([^']+)'/)?.[1];
            const limit = limits[name];
            if (limit && problem.data.lineCount <= limit) return;
            context.report(limit ? { ...problem, data: { ...problem.data, maxLines: limit } } : problem);
          } },
        }));
      },
    },
  },
};

// Existing structural debt: file-specific ceilings, never disabled rules.
const structuralBaselines = [
  ['scripts/verify-release-artifacts.mjs', { complexity: ['error', 22] }], // platform signature validation branches
  ['src/cli/args.ts', { complexity: ['error', 22] }], // OCR option dispatch
  ['src/cli/dedupe.ts', { complexity: ['error', 26] }], // newly landed invoice-number dedupe; separate review
  ['src/cli/ocr.ts', { 'max-depth': ['error', 6] }], // nested OCR command output
  ['src/config.ts', { complexity: ['error', 26] }], // numeric configuration validation
  ['src/electron/cliRunner.ts', { complexity: ['error', 25], 'max-params': ['error', 10] }], // process result/progress plumbing
  ['src/electron/ipc/detailHandlers.ts', { complexity: ['error', 49], 'max-depth': ['error', 5] }], // newly landed detail IPC; separate review
  ['src/electron/ipc/mailHandlers.ts', { complexity: ['error', 31] }], // mail open fallbacks and IPC validation
  ['src/electron/ipc/operationHandlers.ts', { complexity: ['error', 32] }], // operation dispatch and response construction
  ['src/electron/ocrRerun.ts', { 'max-depth': ['error', 5] }], // journaled OCR restoration
  ['src/electron/openPolicy.ts', { complexity: ['error', 37] }], // file signature and open-target checks
  ['src/electron/operationSupport.ts', { 'max-depth': ['error', 5] }], // operation error reporting
  ['src/electron/summary.ts', { complexity: ['error', 26] }], // newly landed library/inbox aggregation; separate review
  ['src/extract/attachment.ts', { complexity: ['error', 36], 'max-depth': ['error', 5] }], // attachment classification and traversal
  ['src/extract/directLink.ts', { complexity: ['error', 27] }], // document response validation
  ['src/mail/fetcher.ts', { complexity: ['error', 31], 'max-depth': ['error', 6] }], // mail materialization and mailbox iteration
  ['src/ocr/efapiao/binary.ts', { complexity: ['error', 24] }], // platform-specific OCR environment
  ['src/ocr/runner.ts', { 'max-params': ['error', 8] }], // OCR row processing context
  ['src/ocr/summary.ts', { complexity: ['error', 51] }], // OCR result aggregation
  ['src/pipeline/processMail.ts', { 'max-params': ['error', 10] }], // archive ledger context
  ['src/sites/common.ts', { complexity: ['error', 25] }], // archive entry validation
  ['src/util/dataDirLock/acquire.ts', { 'max-depth': ['error', 5] }], // lock acquisition retries
  ['src/util/dataDirLock/mutex.ts', { complexity: ['error', 21] }], // recovery mutex validation
  ['src/util/pinnedFetch.ts', { complexity: ['error', 25], 'max-params': ['error', 7] }], // pinned request/redirect context
];

export default [
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  { ignores: ['**/node_modules/**', 'dist/**', 'release/**', 'vendor/**', 'gui-design/*.js', 'electron/**'] },
  {
    files: ['src/**/*.ts', 'scripts/**/*.mjs', 'gui-design/tests/**/*.mjs', 'gui-design/src/**/*.{ts,tsx}', 'eslint.config.mjs'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'max-lines-per-function': ['error', { max: 120, skipBlankLines: true, skipComments: true, IIFEs: false }],
      complexity: ['error', 20],
      'max-depth': ['error', 4],
      'max-params': ['error', 6],
      'no-warning-comments': ['error', { terms: ['todo', 'fixme'], location: 'anywhere' }],
      '@typescript-eslint/no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-unused-private-class-members': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      'no-implicit-coercion': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      'max-lines': ['error', { max: 700, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    files: ['gui-design/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
  ...structuralBaselines.map(([file, rules]) => ({ files: [file], rules })),
  {
    files: Object.keys(functionBaselines),
    plugins: { baseline: baselinePlugin },
    rules: {
      'max-lines-per-function': 'off',
      'baseline/max-lines-per-function': ['error', { max: 120, skipBlankLines: true, skipComments: true, IIFEs: false }],
    },
  },
  {
    files: ['src/electron/ipc/operationHandlers.ts'], // 1099 code lines at adoption, rounded up to 50
    rules: { 'max-lines': ['error', { max: 1100, skipBlankLines: true, skipComments: true }] },
  },
  // Existing unused test helpers are retained because gui-design/ belongs to concurrent work.
  { files: ['gui-design/tests/_shared.mjs'], rules: { '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^readdir$', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }] } },
  { files: ['gui-design/tests/electron-ipc-fixture.mjs'], rules: { '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^expectNoText$', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }] } },
  { files: ['gui-design/tests/**'], rules: { 'max-lines-per-function': 'off', complexity: 'off' } },
];
