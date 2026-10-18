import { createHmac } from "node:crypto";
import type { IceServer } from "@proto/protocol";

const DEFAULT_PORT = 3478;
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
const GOOGLE_STUN = "stun:stun.l.google.com:19302";

export interface TurnConfig {
  /** TURN サーバーのホスト名 (ブラウザから到達できるもの) */
  host: string;
  port: number;
  /** coturn の `static-auth-secret` と同じ値 (use-auth-secret) */
  secret: string;
  /** 発行する認証情報の有効期間 */
  ttlSeconds: number;
}

/** 環境変数 TURN_HOST / TURN_SECRET (必須)、TURN_PORT / TURN_TTL_SECONDS から読む。未設定なら null。 */
export function turnConfigFromEnv(env: NodeJS.ProcessEnv): TurnConfig | null {
  const host = env.TURN_HOST?.trim();
  const secret = env.TURN_SECRET?.trim();
  if (!host || !secret) return null;
  return {
    host,
    port: Number(env.TURN_PORT ?? DEFAULT_PORT),
    secret,
    ttlSeconds: Number(env.TURN_TTL_SECONDS ?? DEFAULT_TTL_SECONDS),
  };
}

/**
 * ユーザーごとの時間制限つき TURN 認証情報 (TURN REST API 方式) を含む ICE サーバー設定を作る。
 *
 * username = "<期限の UNIX 秒>:<ユーザー ID>"、credential = base64(HMAC-SHA1(secret, username))。
 * coturn は共有秘密から同じ値を計算して検証するので、秘密はクライアントに渡らない。
 */
export function iceServersFor(
  config: TurnConfig | null,
  userId: string,
  nowMs: number = Date.now(),
): IceServer[] | undefined {
  if (!config) return undefined;
  const expiry = Math.floor(nowMs / 1000) + config.ttlSeconds;
  const username = `${expiry}:${userId}`;
  const credential = createHmac("sha1", config.secret).update(username).digest("base64");
  const origin = `${config.host}:${config.port}`;
  return [
    // STUN は自前の coturn と、念のため公開 STUN の両方
    { urls: [`stun:${origin}`, GOOGLE_STUN] },
    {
      urls: [`turn:${origin}?transport=udp`, `turn:${origin}?transport=tcp`],
      username,
      credential,
    },
  ];
}
