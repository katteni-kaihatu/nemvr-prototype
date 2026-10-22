import type { ClientMessage, JsonValue, SpaceCondition, SpaceMutation, Vec3 } from "@proto/protocol";

type Send = (message: ClientMessage) => boolean;

export class SpaceWriter {
  private readonly send: Send;

  constructor(send: Send) {
    this.send = send;
  }

  newCommandId(): string {
    return crypto.randomUUID();
  }

  createEntity(entityId: string, dimensions: Record<string, JsonValue>): string {
    const commandId = this.newCommandId();
    this.mutate({ commandId, op: "create", entityId, dimensions });
    return commandId;
  }

  patchEntity(
    entityId: string,
    set: Record<string, JsonValue>,
    options: { unset?: string[]; if?: SpaceCondition[]; ifVersion?: number } = {},
  ): string {
    const commandId = this.newCommandId();
    this.mutate({ commandId, op: "patch", entityId, set, ...options });
    return commandId;
  }

  deleteEntity(entityId: string, options: { if?: SpaceCondition[]; ifVersion?: number } = {}): string {
    const commandId = this.newCommandId();
    this.mutate({ commandId, op: "delete", entityId, ...options });
    return commandId;
  }

  duplicateEntity(entityId: string, newEntityId: string): string {
    const commandId = this.newCommandId();
    this.mutate({ commandId, op: "duplicate", entityId, newEntityId });
    return commandId;
  }

  claimEntity(entityId: string): string {
    const commandId = this.newCommandId();
    this.mutate({ commandId, op: "claim", entityId });
    return commandId;
  }

  releaseEntity(entityId: string): string {
    const commandId = this.newCommandId();
    this.mutate({ commandId, op: "release", entityId });
    return commandId;
  }

  moveEntity(entityId: string, position: Vec3, yaw: number, pitch?: number, scale?: number): string {
    const set: Record<string, JsonValue> = {
      "space.position": position,
      "space.yaw": yaw,
    };
    if (typeof pitch === "number") set["space.pitch"] = pitch;
    if (typeof scale === "number") set["space.scale"] = scale;
    return this.patchEntity(entityId, set);
  }

  pose(entityId: string, position: Vec3, head: [number, number, number, number], crouch: number, lean: number): string {
    return this.patchEntity(entityId, {
      "space.position": position,
      "space.head": head,
      "space.crouch": crouch,
      "space.lean": lean,
    });
  }

  video(entityId: string, playing: boolean, time: number): string {
    return this.patchEntity(entityId, {
      "time.playback": { playing, time },
    });
  }

  ipfsPeerId(entityId: string, peerId: string): string {
    return this.patchEntity(entityId, { "peer.ipfsPeerId": peerId });
  }

  importUrl(entityId: string, url: string, position: Vec3, yaw: number, pitch?: number): string {
    const commandId = this.newCommandId();
    this.send({
      type: "space_import_url",
      commandId,
      entityId,
      url,
      position,
      yaw,
      ...(typeof pitch === "number" ? { pitch } : {}),
    });
    return commandId;
  }

  setAvatar(cid: string | null): string {
    const commandId = this.newCommandId();
    this.send({ type: "space_set_avatar", commandId, cid });
    return commandId;
  }

  requestFile(entityId: string): string {
    const commandId = this.newCommandId();
    this.send({ type: "file_request", commandId, entityId });
    return commandId;
  }

  private mutate(mutation: SpaceMutation): void {
    this.send({ type: "space_mutate", mutation });
  }
}
