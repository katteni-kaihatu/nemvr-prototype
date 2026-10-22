import { describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@proto/protocol";
import { SpaceWriter } from "./spaceWriter";

describe("SpaceWriter", () => {
  it("sends create, patch, claim, release and delete mutations", () => {
    const sent: ClientMessage[] = [];
    const writer = new SpaceWriter((message) => {
      sent.push(message);
      return true;
    });

    writer.createEntity("entity-1", { "entity.kind": "box" });
    writer.patchEntity("entity-1", { "space.position": [1, 0, 2] });
    writer.claimEntity("entity-1");
    writer.releaseEntity("entity-1");
    writer.deleteEntity("entity-1");
    writer.duplicateEntity("entity-1", "entity-2");
    writer.importUrl("entity-3", "https://example.com/", [0, 0, 0], 0);
    writer.setAvatar("bafy-avatar");
    writer.requestFile("entity-4");

    const types = sent.map((message) => message.type);
    expect(types).toEqual([
      "space_mutate",
      "space_mutate",
      "space_mutate",
      "space_mutate",
      "space_mutate",
      "space_mutate",
      "space_import_url",
      "space_set_avatar",
      "file_request",
    ]);

    const mutations = sent
      .filter((message): message is Extract<ClientMessage, { type: "space_mutate" }> => message.type === "space_mutate")
      .map((message) => message.mutation);

    expect(mutations.map((mutation) => mutation.op)).toEqual([
      "create",
      "patch",
      "claim",
      "release",
      "delete",
      "duplicate",
    ]);
    expect(new Set(mutations.map((mutation) => mutation.commandId)).size).toBe(6);
  });

  it("uses the provided command ids and returns them", () => {
    const sent: ClientMessage[] = [];
    const writer = new SpaceWriter((message) => {
      sent.push(message);
      return true;
    });

    const commandId = writer.patchEntity("entity-1", { "space.yaw": 1 });
    expect(commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[0]).toMatchObject({ type: "space_mutate", mutation: { commandId, op: "patch" } });
  });

  it("sends nothing when the transport is closed", () => {
    const send = vi.fn(() => false);
    const writer = new SpaceWriter(send);
    writer.claimEntity("entity-1");
    expect(send).toHaveBeenCalledOnce();
  });
});
