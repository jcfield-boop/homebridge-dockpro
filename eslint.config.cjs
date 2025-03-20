// eslint.config.cjs
const { FlatCompat } = require('@eslint/eslintrc');
const { configs } = require('@eslint/js');
const compat = new FlatCompat({
    baseDirectory: __dirname,
    resolvePluginsRelativeTo: __dirname,
    recommendedConfig: configs.recommended,
});

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**']
  },
  ...compat.extends('eslint:recommended'),
  ...compat.extends('plugin:@typescript-eslint/recommended'),
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: require('@typescript-eslint/parser'),
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
      globals: {
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': require('@typescript-eslint/eslint-plugin'),
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];