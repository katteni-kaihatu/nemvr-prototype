import schema from "../space-schema.json";

export const SPACE_SCHEMA_VERSION = schema.schemaVersion;
export const SPACE_PROTOCOL_VERSION = 2;
export const SPACE_TEMPLATE_ID = "vr-sns-3d";
export const DEFAULT_SESSION_ID = "main";
export const SPACE_TICK_RATE = 20;
export const SPACE_TICK_INTERVAL_MS = 1000 / SPACE_TICK_RATE;
export const MAX_SPACE_ENTITIES = schema.maxObjects;
export const MAX_SPACE_DIMENSIONS = schema.maxDimensions;
export const MAX_SPACE_ENTITY_BYTES = schema.maxEntityBytes;
export const MAX_SPACE_FILTER_PREDICATES = schema.maxFilterPredicates;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SpaceVec3 = [number, number, number];
export type SpaceQuat = [number, number, number, number];

export interface DimensionSpec {
  type: "string" | "number" | "boolean" | "enum" | "vec3" | "quat" | "object" | "playback" | "color";
  write: "client" | "server" | "create" | "claim" | "avatar";
  values?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  nullable?: boolean;
}

export interface SpaceEntity {
  id: string;
  version: number;
  dimensions: Record<string, JsonValue>;
}

export type SpacePredicate =
  | { dim: string; eq: JsonValue }
  | { dim: string; in: JsonValue[] }
  | { dim: string; range: { min?: number; max?: number } }
  | { dim: "space.position"; within: { min: SpaceVec3; max: SpaceVec3 } };

export interface SpaceFilter {
  all?: SpacePredicate[];
  any?: SpacePredicate[];
  not?: SpaceFilter;
}

export interface SpaceScope {
  sessionId: string;
  read: {
    dims: string[];
    filter: SpaceFilter;
  };
  write: {
    dims: string[];
    filter: SpaceFilter;
    canCreate: boolean;
    canDelete: boolean;
    maxEntities: number;
  };
}

export interface SpaceCondition {
  dim: string;
  eq?: JsonValue;
  isAbsent?: boolean;
}

export type SpaceMutation =
  | { commandId: string; op: "create"; entityId: string; dimensions: Record<string, JsonValue> }
  | {
      commandId: string;
      op: "patch";
      entityId: string;
      set?: Record<string, JsonValue>;
      unset?: string[];
      if?: SpaceCondition[];
      ifVersion?: number;
    }
  | { commandId: string; op: "delete"; entityId: string; if?: SpaceCondition[]; ifVersion?: number }
  | { commandId: string; op: "duplicate"; entityId: string; newEntityId: string }
  | { commandId: string; op: "claim"; entityId: string }
  | { commandId: string; op: "release"; entityId: string };

export interface SpaceChange {
  op: "upsert" | "remove";
  entity?: SpaceEntity;
  id?: string;
  version?: number;
}

export const SPACE_SCHEMA = schema;

export type DimensionSchema = Record<string, DimensionSpec>;
