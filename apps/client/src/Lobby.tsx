import { useState, type FormEvent } from "react";
import { MAX_NAME_LENGTH } from "@proto/protocol";
import { connect, useNet } from "./net/connection";

export function Lobby() {
  const [name, setName] = useState("");
  const status = useNet((s) => s.status);
  const message = useNet((s) => s.message);
  const connecting = status === "connecting";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!connecting) connect(name);
  };

  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12, width: 280 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>VR SNS Prototype</h1>
        <input
          autoFocus
          value={name}
          maxLength={MAX_NAME_LENGTH}
          placeholder="表示名 (空欄で Guest)"
          onChange={(e) => setName(e.target.value)}
          style={{ padding: 8, fontSize: 16 }}
        />
        <button type="submit" disabled={connecting} style={{ padding: 8, fontSize: 16 }}>
          {connecting ? "接続中..." : "入室"}
        </button>
        {message && <div style={{ color: "#ff8a80", fontSize: 14 }}>{message}</div>}
      </form>
    </div>
  );
}
