import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/; without this, vitest crawls into them and runs stale copies of the suite.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
})
