import { Component, Entity } from "@javelin/ecs"
import {
  assert,
  ChangeSet,
  createModel,
  flattenModel,
  Model,
  ModelFlat,
  ModelNodeKind,
  mutableEmpty,
  NO_OP,
} from "@javelin/model"
import {
  decode,
  encode,
  isView,
  uint16,
  uint32,
  uint8,
  View,
} from "@javelin/pack"
import { decodeSchema, encodeModel } from "./model"

type Indices<T extends { length: number }> = Exclude<
  Partial<T>["length"],
  T["length"]
>

type Part = {
  data: unknown[]
  type: (View<unknown> | null)[]
  byteLength: number
}
type PartTick = Part
type PartModel = Part
type PartSpawn = Part
type PartAttach = Part
type PartUpdate = Part
/**
 * p: [
 *   1: entity
 *   2: component id [
 *     a: field count
 *     b: field [
 *       1: traverse length
 *       2: traverse keys
 *       3: value
 *     ]
 *   ]
 * ]
 */
type PartPatch = Part & {
  changeMapByEntity: Map<Entity, Map<number, ChangeSet>>
}
type PartDetach = Part
type PartDestroy = Part
type Parts = [
  PartTick,
  PartModel,
  PartSpawn,
  PartAttach,
  PartUpdate,
  PartPatch,
  PartDetach,
  PartDestroy,
]

type Message = {
  parts: Parts
  model: Model
  modelFlat: ModelFlat
}

const createPart = (): Part => {
  return {
    data: [],
    type: [],
    byteLength: 0,
  }
}

const encodePartHeader = (
  bufferView: DataView,
  offset: number,
  byteLength: number,
) => {
  uint16.write(bufferView, offset, byteLength)
  offset += uint16.byteLength
  return offset
}

const encodePart = (
  buffer: ArrayBuffer,
  bufferView: DataView,
  offset: number,
  message: Message,
  partsIndex: Indices<Parts>,
) => {
  const part = message.parts[partsIndex]

  offset = encodePartHeader(bufferView, offset, part.byteLength)

  switch (partsIndex) {
    case 5: {
      const patch = message.parts[partsIndex]
      patch.changeMapByEntity.forEach((changeMap, entity) => {
        // (p.1) entity
        uint32.write(bufferView, offset, entity)
        offset += uint32.byteLength
        changeMap.forEach((changeSet, componentId) => {
          const { fields, fieldsCount } = changeSet
          const type = message.modelFlat[componentId]
          // (p.2) component id
          uint8.write(bufferView, offset, componentId)
          offset += uint8.byteLength
          // (p.2.a) field count
          uint8.write(bufferView, offset, fieldsCount)
          offset += uint8.byteLength
          for (const prop in fields) {
            const change = fields[prop]
            if (change === NO_OP) {
              continue
            }
            const { field, traverse, value } = change
            // (p.2.b) field
            uint8.write(bufferView, offset, field)
            offset += uint8.byteLength
            // (p.2.b.1) traverse length
            uint8.write(bufferView, offset, traverse?.length ?? 0)
            offset += uint8.byteLength
            // (p.2.b.2) traverse keys
            if (traverse !== undefined) {
              for (let i = 0; i < traverse.length; i++) {
                uint16.write(bufferView, offset, +traverse[i])
                offset += uint16.byteLength
              }
            }
            // (p.2.b.3) value
            const typeField = type[field]
            assert(
              typeField.kind === ModelNodeKind.Primitive,
              "Failed to encode patch: only primitive field mutations are currently supported",
            )
            const view = typeField.type
            assert(isView(view))
            view.write(bufferView, offset, value)
            offset += view.byteLength
          }
        })
      })
      break
    }
    default:
      for (let i = 0; i < part.data.length; i++) {
        const data = part.data[i]
        const view = part.type[i]

        if (data instanceof ArrayBuffer) {
          new Uint8Array(buffer, 0, buffer.byteLength).set(
            new Uint8Array(data),
            offset,
          )
          offset += data.byteLength
        } else {
          ;(view as View).write(bufferView, offset, data)
          offset += (view as View).byteLength
        }
      }
      break
  }

  return offset
}

const insert = (part: Part, data: any, type: View<unknown>) => {
  part.data.push(data)
  part.type.push(type)
  part.byteLength += type.byteLength
}

const insertEntityComponents = (
  part: Part,
  entity: Entity,
  components: Component[],
  model: Model,
) => {
  // entity
  insert(part, entity, uint32)
  // component length
  insert(part, components.length, uint8)

  for (let i = 0; i < components.length; i++) {
    const component = components[i]
    const componentId = component._tid
    const componentEncoded = encode(component, model[componentId])
    // component type id
    insert(part, componentId, uint8)
    // encoded component length
    insert(part, componentEncoded.byteLength, uint16)
    // encoded component
    insertBuffer(part, componentEncoded)
  }
}

const insertBuffer = (part: Part, data: ArrayBuffer) => {
  part.data.push(data)
  part.type.push(null)
  part.byteLength += data.byteLength
}

export const encodeMessage = (
  message: Message,
  includeModel = false,
): ArrayBuffer => {
  const { parts } = message
  let length = 0

  for (let i = 0; i < parts.length; i++) {
    // header
    length += uint16.byteLength
    // exclude model
    if (i === 1 && includeModel === false) {
      continue
    }
    // part
    length += parts[i].byteLength
  }

  const buffer = new ArrayBuffer(length)
  const bufferView = new DataView(buffer)

  let offset = 0

  for (let i = 0; i < parts.length; i++) {
    // exclude model
    if (i === 1 && includeModel === false) {
      offset = encodePartHeader(bufferView, offset, 0)
    } else {
      offset = encodePart(
        buffer,
        bufferView,
        offset,
        message,
        i as Indices<Parts>,
      )
    }
  }

  return buffer
}
export { encodeMessage as encode }

export const createMessage = (model: Model): Message => {
  const partModel = createPart()
  insertBuffer(partModel, encodeModel(model))
  return {
    parts: [
      createPart(),
      partModel,
      createPart(),
      createPart(),
      createPart(),
      { ...createPart(), changeMapByEntity: new Map() },
      createPart(),
      createPart(),
    ],
    model,
    modelFlat: flattenModel(model),
  }
}

export const copy = (from: Message, to: Message): Message => {
  const { parts } = from
  for (let j = 0; j < parts.length; j++) {
    const { type, data, byteLength } = parts[j]
    const dest = to.parts[j]
    const { data: dataDest, type: dataType } = dest
    for (let k = 0; k < data.length; k++) {
      dataDest.push(data[k])
      dataType.push(type[k])
    }
    dest.byteLength += byteLength
  }
  return to
}

export const reset = (message: Message) => {
  const { parts } = message
  for (let i: Indices<Parts> = 0; i < parts.length; i++) {
    const part = parts[i]
    switch (i) {
      case 5:
        ;(part as PartPatch).changeMapByEntity.clear()
      default:
        mutableEmpty(part.data)
        mutableEmpty(part.type)
        part.byteLength = 0
        break
    }
  }
}

export const spawn = (
  message: Message,
  entity: Entity,
  components: Component[] = [],
) => insertEntityComponents(message.parts[2], entity, components, message.model)

export const attach = (
  message: Message,
  entity: Entity,
  ...components: Component[]
) => insertEntityComponents(message.parts[3], entity, components, message.model)

export const update = (
  message: Message,
  entity: Entity,
  ...components: Component[]
) => insertEntityComponents(message.parts[4], entity, components, message.model)

const calcChangeByteLength = (
  changeSet: ChangeSet,
  modelFlat: ModelFlat[keyof ModelFlat],
) => {
  const { fields } = changeSet

  let byteLength = 0

  for (const prop in fields) {
    const change = fields[prop]
    if (change === NO_OP) {
      continue
    }
    const { field, traverse } = change
    // (p.2.b) field
    byteLength += uint8.byteLength
    // (p.2.b.1) traverse length
    byteLength += uint8.byteLength
    // (p.2.b.2) traverse keys
    byteLength += uint16.byteLength * (traverse?.length ?? 0)
    // (p.2.b.3) value
    const node = modelFlat[field]
    assert(
      node.kind === ModelNodeKind.Primitive,
      "Failed to encode change: only primitive field mutations are currently supported",
    )
    const { type } = node
    assert(isView(type))
    byteLength += type.byteLength
  }

  return byteLength
}

export const patch = (
  message: Message,
  entity: Entity,
  componentId: number,
  changeSet: ChangeSet,
) => {
  const part = message.parts[5]
  const { fieldsCount } = changeSet

  if (fieldsCount === 0) {
    return
  }

  let delta = 0
  let changeMap = part.changeMapByEntity.get(entity)

  if (changeMap === undefined) {
    changeMap = new Map()
    part.changeMapByEntity.set(entity, changeMap)
    // (p.1) entity
    delta += uint32.byteLength
  }

  const componentFieldTypes = message.modelFlat[componentId]
  const existingChanges = changeMap.get(componentId)

  if (existingChanges) {
    delta -= calcChangeByteLength(existingChanges, componentFieldTypes)
  } else {
    // (p.2) component id
    delta += uint8.byteLength
    // (p.2.a) field count
    delta += uint8.byteLength
  }

  changeMap.set(componentId, changeSet)

  part.byteLength +=
    delta + calcChangeByteLength(changeSet, componentFieldTypes)
}

export const detach = (
  message: Message,
  entity: Entity,
  ...componentIds: number[]
) => {
  const part = message.parts[6]
  const length = componentIds.length
  insert(part, entity, uint32)
  insert(part, length, uint8)
  for (let i = 0; i < length; i++) {
    insert(part, componentIds[i], uint8)
  }
}

export const destroy = (message: Message, entity: Entity) => {
  const part = message.parts[7]
  insert(part, entity, uint32)
}

export const tick = (message: Message, tick: number) => {
  const part = message.parts[0]
  insert(part, tick, uint32)
}

export function decodeModel(
  buffer: ArrayBuffer,
  bufferView: DataView,
  offset: number,
  onModel: (model: Model) => void,
) {
  const length = uint16.read(bufferView, offset, 0)
  // header
  offset += uint16.byteLength
  if (length === 0) {
    return offset
  }

  const config = new Map()
  const encoded = new Uint8Array(buffer, offset, length)

  let i = 0

  while (i < length) {
    const schema = {}
    const componentTypeId = encoded[i++]
    i = decodeSchema(encoded, i, schema)
    config.set(componentTypeId, schema)
  }

  onModel(createModel(config))

  return offset + length
}

function decodeEntityComponentsPart(
  buffer: ArrayBuffer,
  bufferView: DataView,
  model: Model,
  offset: number,
  onInsert: (entity: number, components: Component[]) => void,
) {
  const length = uint16.read(bufferView, offset, 0)
  const end = offset + length

  offset += uint16.byteLength

  while (offset < end) {
    const components: Component[] = []
    const entity = uint32.read(bufferView, offset, 0)
    offset += uint32.byteLength
    const componentLength = uint8.read(bufferView, offset, 0)
    offset += uint8.byteLength

    for (let i = 0; i < componentLength; i++) {
      const componentTypeId = uint8.read(bufferView, offset, 0)
      offset += uint8.byteLength
      const encodedComponentLength = uint16.read(bufferView, offset, 0)
      offset += uint16.byteLength
      const encodedComponent = buffer.slice(
        offset,
        offset + encodedComponentLength,
      )
      offset += encodedComponentLength
      const component = decode<Component>(
        encodedComponent,
        model[componentTypeId],
      )
      ;(component as any)._tid = componentTypeId
      components.push(component)
    }

    onInsert(entity, components)
  }

  return offset
}

function decodeDetach(
  bufferView: DataView,
  offset: number,
  onDetach: (entity: number, componentTypeIds: number[]) => void,
) {
  const detachLength = uint16.read(bufferView, offset, 0)
  const detachEnd = offset + detachLength

  offset += uint16.byteLength

  while (offset < detachEnd) {
    const componentTypeIds = []
    const entity = uint32.read(bufferView, offset, 0)
    offset += uint32.byteLength
    const componentTypeIdsLength = uint8.read(bufferView, offset, 0)
    offset += uint8.byteLength

    for (let i = 0; i < componentTypeIdsLength; i++) {
      const componentTypeId = uint8.read(bufferView, offset, 0)
      offset += uint8.byteLength
      componentTypeIds.push(componentTypeId)
    }

    onDetach(entity, componentTypeIds)
  }

  return offset
}

function decodeDestroy(
  bufferView: DataView,
  offset: number,
  onDestroy: (entity: number) => void,
) {
  const destroyLength = uint16.read(bufferView, offset, 0)
  const destroyEnd = offset + destroyLength

  offset += uint16.byteLength

  while (offset < destroyEnd) {
    const entity = uint32.read(bufferView, offset, 0)
    offset += uint32.byteLength
    onDestroy(entity)
  }

  return offset
}

export type DecodeMessageHandlers = {
  onTick(tick: number): void
  onModel(model: Model): void
  onCreate(entity: number, components: Component[]): void
  onAttach(entity: number, components: Component[]): void
  onUpdate(entity: number, components: Component[]): void
  onDetach(entity: number, componentTypeIds: number[]): void
  onDestroy(entity: number): void
  onPatch(
    buffer: ArrayBuffer,
    bufferView: DataView,
    model: Model,
    offset: number,
  ): void
}

export function decodeMessage(
  buffer: ArrayBuffer,
  handlers: DecodeMessageHandlers,
  model?: Model,
) {
  const {
    onTick,
    onModel,
    onCreate,
    onAttach,
    onUpdate,
    onDetach,
    onDestroy,
    onPatch,
  } = handlers
  const _onModel = (m: Model) => {
    model = m
    onModel(m)
  }
  const bufferView = new DataView(buffer)

  let offset = 0

  const tickLength = uint16.read(bufferView, offset)
  offset += uint16.byteLength

  if (tickLength > 0) {
    const tick = uint32.read(bufferView, offset, 0)
    onTick(tick)
    offset += tickLength
  }

  offset = decodeModel(buffer, bufferView, offset, _onModel)
  assert(
    model !== undefined,
    "Failed to decode network message: model not provided to decodeMessage() nor, was it encoded in message",
  )
  // spawn
  offset = decodeEntityComponentsPart(
    buffer,
    bufferView,
    model,
    offset,
    onCreate,
  )
  // attach
  offset = decodeEntityComponentsPart(
    buffer,
    bufferView,
    model,
    offset,
    onAttach,
  )
  // update
  offset = decodeEntityComponentsPart(
    buffer,
    bufferView,
    model,
    offset,
    onUpdate,
  )
  // TODO: patch iterator
  // patch
  const patchLength = uint16.read(bufferView, offset)
  onPatch(buffer, bufferView, model, offset)
  offset += patchLength + uint16.byteLength
  // detach
  offset = decodeDetach(bufferView, offset, onDetach)
  // destroy
  offset = decodeDestroy(bufferView, offset, onDestroy)
}
