module.exports = {
  parser: '@typescript-eslint/parser',
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  plugins: ['@typescript-eslint'],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  env: {
    node: true,
    es6: true,
    browser: true  // This will define setTimeout, setInterval, etc.
  },
  rules: {
    // Best practices
    'eqeqeq': 'warn',
    'no-var': 'error',
    'prefer-const': 'warn',
    'no-console': 'warn',
    
    // TypeScript specific
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { 
      'argsIgnorePattern': '^_',
      'varsIgnorePattern': '^_'
    }],
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-inferrable-types': 'warn',
    
    // Code style
    '@typescript-eslint/semi': ['error', 'always'],
    'quotes': ['warn', 'single', { 'avoidEscape': true, 'allowTemplateLiterals': true }],
    
    // Allow non-null assertions in reasonable contexts
    '@typescript-eslint/no-non-null-assertion': 'off',
  },
  ignorePatterns: [
    'dist/**',
    'node_modules/**'
  ]
};