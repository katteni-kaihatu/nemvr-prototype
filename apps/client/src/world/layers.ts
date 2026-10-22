/**
 * ローカルの自分のアバターを描くレイヤー。
 * メインのカメラ (一人称) はレイヤー 0 だけを描き、鏡の反射カメラだけがこのレイヤーも描く。
 * これにより、自分の体はメイン視点には出さず、鏡の中だけに映る。
 */
export const LOCAL_AVATAR_LAYER = 1;

/** 通常のカメラで描く名前タグ。鏡の反射カメラからは外す。 */
export const NAMEPLATE_LAYER = 2;
/** 鏡の中だけで描く、左右反転済みの名前タグ。反射による反転を打ち消す。 */
export const NAMEPLATE_MIRROR_LAYER = 3;
