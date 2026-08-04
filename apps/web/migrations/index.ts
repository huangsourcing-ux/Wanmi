import * as migration_20260803_095130_d0_initial from './20260803_095130_d0_initial'

export const migrations = [
  {
    up: migration_20260803_095130_d0_initial.up,
    down: migration_20260803_095130_d0_initial.down,
    name: '20260803_095130_d0_initial',
  },
]
