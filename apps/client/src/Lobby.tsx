import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatBytes, MAX_AVATAR_BYTES, MAX_NAME_LENGTH } from "@proto/protocol";
import { clearSavedAvatar, loadSavedAvatar, loadSavedName, saveAvatar, saveName } from "./avatarStore";
import { connect, useNet } from "./net/connection";

export function Lobby() {
  const [name, setName] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  /** 表示中のアバターが、前回保存したものか (ファイル入力を触っていない) */
  const [avatarFromSaved, setAvatarFromSaved] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const status = useNet((s) => s.status);
  const message = useNet((s) => s.message);
  const connecting = status === "connecting";

  // 前回の表示名とアバターを読み込む (次に入室するとき、選び直さなくてよいように)
  useEffect(() => {
    setName(loadSavedName());
    let cancelled = false;
    void loadSavedAvatar().then((file) => {
      if (cancelled || !file) return;
      setAvatarFile(file);
      setAvatarFromSaved(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (connecting) return;
    saveName(name);
    connect(name, avatarFile ?? undefined);
  };

  const onSelectAvatar = (file: File | null) => {
    if (!file) return; // ダイアログを閉じただけなら、いまのまま
    setAvatarFromSaved(false);
    setAvatarError(null);
    // 前回のアバターは、新しい選択に置き換える (大きすぎる場合は保存しない)
    void clearSavedAvatar();
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setAvatarError("アバターが大きすぎます (64MB まで)");
      return;
    }
    setAvatarFile(file);
    void saveAvatar(file);
  };

  const clearAvatar = () => {
    setAvatarFile(null);
    setAvatarFromSaved(false);
    setAvatarError(null);
    if (fileInput.current) fileInput.current.value = "";
    void clearSavedAvatar();
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
              onChange={(e) => onSelectAvatar(e.target.files?.[0] ?? null)}
              style={{ display: "block", marginTop: 4, width: "100%", fontSize: 13 }}
            />
          </label>
          {avatarFile && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
              <span
                title={avatarFile.name}
                style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {avatarFromSaved ? "前回のアバター: " : ""}
                {avatarFile.name} ({formatBytes(avatarFile.size)})
              </span>
              <button type="button" onClick={clearAvatar} style={{ padding: "2px 8px", fontSize: 12 }}>
                クリア
              </button>
            </div>
          )}
          {avatarError && <div style={{ color: "#ff8a80", fontSize: 12 }}>{avatarError}</div>}
        </div>
        <button type="submit" disabled={connecting} style={{ padding: 8, fontSize: 16 }}>
          {connecting ? "接続中..." : "入室"}
        </button>
        {message && <div style={{ color: "#ff8a80", fontSize: 14 }}>{message}</div>}
      </form>
    </div>
  );
}
