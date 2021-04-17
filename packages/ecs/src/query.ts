import { mutableEmpty } from "@javelin/model"
import { Archetype, ArchetypeTableColumn } from "./archetype"
import {
  Component,
  ComponentOf,
  ComponentType,
  registerComponentType,
} from "./component"
import { globals } from "./internal/globals"
import { $type } from "./internal/symbols"
import { createStackPool } from "./pool"
import { typeIsSuperset } from "./type"
import { Collection } from "./types"

export type Selector = ComponentType[]
export type SelectorResult<S extends Selector> = {
  [K in keyof S]: S[K] extends ComponentType ? ComponentOf<S[K]> : Component
}

export type QueryRecord<S extends Selector> = [
  entities: ReadonlyArray<number>,
  columns: {
    [K in keyof S]: S[K] extends ComponentType
      ? ArchetypeTableColumn<S[K]>
      : never
  },
]
export type QueryForEachRecord<S extends Selector> = [
  entity: number,
  selectorResult: SelectorResult<S>,
]
export type Query<S extends Selector = Selector> = Collection<
  QueryForEachRecord<S>,
  QueryRecord<S>
> & {
  readonly layout: number[]
  readonly length: number
  readonly signature: number[]
  readonly filters: {
    not: ReadonlySet<number>
  }

  /**
   * Exclude entities with components of provided component type(s) from the
   * query results.
   * @param selector
   */
  not(...selector: Selector): Query<S>
}

export const queryMatchesArchetype = (query: Query, archetype: Archetype) =>
  typeIsSuperset(archetype.signature, query.signature) &&
  archetype.signature.every(c => !query.filters.not.has(c))

/**
 * Create a query that can be used to iterate over entities that match a
 * provided component type selector. Maintains an automatically-updated
 * cache of archetypes, and can be used across multiple worlds.
 * @param selector Query selector
 * @returns Query
 * @example
 * const burning = createQuery(Player, Burn)
 * burning.forEach((entity, [player, burn]) => {
 *   player.health -= burn.damage
 * })
 */
export function createQuery<S extends Selector>(...selector: S): Query<S> {
  const length = selector.length
  const layout = selector.map(componentType =>
    registerComponentType(componentType),
  )
  const filters = {
    not: new Set<number>(),
  }
  const signature = layout.slice().sort((a, b) => a - b)
  const recordsByWorldId = [] as QueryRecord<S>[][]
  const maybeRegisterArchetype = (
    archetype: Archetype,
    records: QueryRecord<S>[],
  ) => {
    if (queryMatchesArchetype(query, archetype)) {
      const columns = layout.map(
        componentTypeId =>
          archetype.table[archetype.signature.indexOf(componentTypeId)],
      )
      records.push([archetype.entities, columns as QueryRecord<S>[1]])
    }
  }
  const registerWorld = (worldId: number) => {
    const world = globals.__WORLDS__[worldId]
    const records: QueryRecord<S>[] = []
    recordsByWorldId[worldId] = records
    world.storage.archetypes.forEach(archetype =>
      maybeRegisterArchetype(archetype, records),
    )
    world.storage.archetypeCreated.subscribe(archetype =>
      maybeRegisterArchetype(archetype, records),
    )
    return records
  }
  const pool = createStackPool<SelectorResult<S>>(
    () => ([] as unknown) as SelectorResult<S>,
    components => {
      mutableEmpty(components)
      return components
    },
    1000,
  )

  const query: Query<S> = {
    layout,
    length,
    signature,
    filters,
    not(...selector: Selector) {
      for (let i = 0; i < selector.length; i++) {
        filters.not.add(selector[i][$type])
      }
      return query
    },
    forEach(iteratee) {
      const records =
        recordsByWorldId[globals.__CURRENT_WORLD__] ||
        registerWorld(globals.__CURRENT_WORLD__)
      const components = pool.retain()

      for (let i = 0; i < records.length; i++) {
        const [entities, columns] = records[i]
        for (let j = 0; j < entities.length; j++) {
          for (let k = 0; k < length; k++) {
            components[k] = columns[k][j]
          }
          iteratee(entities[j], components)
        }
      }

      pool.release(components)
    },
    [Symbol.iterator]() {
      return (recordsByWorldId[globals.__CURRENT_WORLD__] ||
        registerWorld(globals.__CURRENT_WORLD__))[Symbol.iterator]()
    },
  }

  return query
}
