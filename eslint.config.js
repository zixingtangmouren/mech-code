import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/*.config.ts', '**/*.config.js'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['packages/*/examples/*.ts'],
          defaultProject: 'tsconfig.json',
        },
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/examples/**/*.ts'],
    rules: {
      '@typescript-eslint/no-implied-eval': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
)
