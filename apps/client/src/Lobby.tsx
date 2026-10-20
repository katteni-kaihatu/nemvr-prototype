import { useRef, useState, type FormEvent } from "react";
import { formatBytes, MAX_NAME_LENGTH } from "@proto/protocol";
import { connect, useNet } from "./net/connection";

export function Lobby() {
  const [name, setName] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const status = useNet((s) => s.status);
  const message = useNet((s) => s.message);
  const connecting = status === "connecting";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!connecting) connect(name, avatarFile ?? undefined);
  };

  const clearAvatar = () => {
    setAvatarFile(null);
    if (fileInput.current) fileInput.current.value = "";
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
        <div style={{ display: "grid", gap: 4 }}>
          <label style={{ fontSize: 14 }}>
            アバター (VRM、任意)
            <input
              ref={fileInput}
              type="file"
              accept=".vrm,model/gltf-binary"
              onChange={(e) => setAvatarFile(e.target.files?.[0] ?? null)}
              style={{ display: "block", marginTop: 4, width: "100%", fontSize: 13 }}
            />
          </label>
          {avatarFile && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
              <span
                title={avatarFile.name}
                style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {avatarFile.name} ({formatBytes(avatarFile.size)})
              </span>
              <button type="button" onClick={clearAvatar} style={{ padding: "2px 8px", fontSize: 12 }}>
                クリア
              </button>
            </div>
          )}
        </div>
        <button type="submit" disabled={connecting} style={{ padding: 8, fontSize: 16 }}>
          {connecting ? "接続中..." : "入室"}
        </button>
        {message && <div style={{ color: "#ff8a80", fontSize: 14 }}>{message}</div>}
      </form>
    </div>
  );
}
