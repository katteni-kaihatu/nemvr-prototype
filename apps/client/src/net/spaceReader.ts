import type { ServerMessage, SpaceEntity } from "@proto/protocol";

export class SpaceReader {
  readonly entities = new Map<string, SpaceEntity>();
  version = 0;
  seq = 0;
  subscriptionId = "";

  reset(): void {
    this.entities.clear();
    this.version = 0;
    this.seq = 0;
    this.subscriptionId = "";
  }

  applyWelcome(message: Extract<ServerMessage, { type: "space_welcome" }>): void {
    this.entities.clear();
    for (const entity of message.entities) this.entities.set(entity.id, entity);
    this.version = message.version;
    this.seq = message.seq;
    this.subscriptionId = message.subscriptionId;
  }

  applySnapshot(message: Extract<ServerMessage, { type: "space_snapshot" }>): void {
    this.entities.clear();
    for (const entity of message.entities) this.entities.set(entity.id, entity);
    this.version = message.version;
    this.seq = message.seq;
    this.subscriptionId = message.subscriptionId;
  }

  /** Returns true when a delta was applied, false when it was stale or a gap was detected. */
  applyDelta(message: Extract<ServerMessage, { type: "space_delta" }>): boolean {
    if (message.subscriptionId !== this.subscriptionId) return false;
    if (message.seq <= this.seq) return false;
    if (message.seq !== this.seq + 1) return false;

    for (const change of message.changes) {
      if (change.op === "upsert" && change.entity) {
        const current = this.entities.get(change.entity.id);
        if (!current || change.entity.version >= current.version) {
          this.entities.set(change.entity.id, change.entity);
        }
      } else if (change.op === "remove" && change.id) {
        this.entities.delete(change.id);
      }
    }

    this.version = message.version;
    this.seq = message.seq;
    return true;
  }

  values(): SpaceEntity[] {
    return [...this.entities.values()];
  }
}
