import {
  Component,
  ComponentFactoryLike,
  ComponentWithoutEntity,
  DataType,
  isDataType,
  Schema,
  SchemaKey,
  World,
} from "@javelin/ecs"

export enum JavelinMessageType {
  // Core
  Create,
  Destroy,
  Update,
  // Debug
  Spawn,
  Model,
}

export type SerializedComponentType<
  C extends ComponentFactoryLike = ComponentFactoryLike
> = {
  name: C["name"]
  type: C["type"]
  schema: SerializedSchema<C["schema"]>
}

export type Create = [JavelinMessageType.Create, Component[], boolean]
export type Destroy = [JavelinMessageType.Destroy, number[], boolean]
export type Update = [JavelinMessageType.Update, Component[], boolean, unknown]
export type Spawn = [JavelinMessageType.Spawn, ComponentWithoutEntity[]]
export type Model = [JavelinMessageType.Model, SerializedComponentType[]]

export type SerializedSchema<S extends Schema = {}> = S extends DataType<
  infer T
>
  ? T
  : {
      [K in keyof S]: S[K] extends Schema
        ? SerializedSchema<S>
        : S[K] extends DataType<any>
        ? S[K]["name"]
        : never
    }

export function serializeSchema<S extends Schema>(
  schema: S,
): SerializedSchema<S> {
  const out: any = {}

  for (const prop in schema) {
    const value = schema[prop] as SchemaKey

    if (isDataType(value)) {
      out[prop] = value.name
    } else if ("type" in value && isDataType(value.type)) {
      out[prop] = value.type.name
    } else {
      out[prop] = serializeSchema(value as Schema)
    }
  }

  return out as SerializedSchema<S>
}

export function serializeWorldModel(world: World): SerializedComponentType[] {
  return world.registeredComponentFactories.map(t => ({
    name: t.name,
    type: t.type,
    schema: serializeSchema(t.schema),
  }))
}

export function setUpdateMetadata(update: Update, metadata: unknown): Update {
  const copy = update.slice()
  update[3] = metadata
  return copy as Update
}

export const protocol = {
  create: (components: Component[], isLocal = false): Create => [
    JavelinMessageType.Create,
    components,
    isLocal,
  ],
  destroy: (entities: number[], isLocal = false): Destroy => [
    JavelinMessageType.Destroy,
    entities,
    isLocal,
  ],
  update: (
    components: Component[],
    metadata?: unknown,
    isLocal = false,
  ): Update => [JavelinMessageType.Update, components, isLocal, metadata],
  spawn: (components: ComponentWithoutEntity[]): Spawn => [
    JavelinMessageType.Spawn,
    components,
  ],
  model: (world: World): Model => [
    JavelinMessageType.Model,
    serializeWorldModel(world),
  ],
}

export type JavelinProtocol = typeof protocol
export type JavelinMessage = {
  [K in keyof JavelinProtocol]: ReturnType<JavelinProtocol[K]>
}[keyof JavelinProtocol]
