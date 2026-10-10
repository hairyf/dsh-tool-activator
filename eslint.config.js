import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'lib',
  pnpm: true,
  react: true,
  ignores: ['source/**', 'licenses/**'],
})
