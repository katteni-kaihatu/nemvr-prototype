import { formatBytes, iconLabel, type FileCategory } from "@proto/protocol";

/**
 * ファイルアイコンの描画 (2D canvas)。3D 空間の板に貼るテクスチャになる。
 * 板の縦横比 (FILE_ICON_WIDTH : FILE_ICON_HEIGHT = 3 : 4) に合わせた大きさで描く。
 *
 * ファイルの形 (角が折れたページ) に、種類ごとの絵柄を描く。
 * - 音声: 紫のページに、スピーカーと音波
 * - 映像: 橙のページに、再生マークと、フィルムの穴
 * - それ以外: 白いページに、拡張子のバッジと、文章の行
 * ページの下に、ファイル名とサイズの欄を付ける。
 */

export const ICON_CANVAS_WIDTH = 512;
export const ICON_CANVAS_HEIGHT = 683;

const FONT = '"Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif';

// ページ (角が折れた長方形)
const PAGE = { x: 48, y: 24, w: 416, h: 446, r: 30, fold: 104 };
// ファイル名とサイズの欄
const LABEL = { x: 24, y: 490, w: 464, h: 169, r: 26 };

interface Palette {
  top: string;
  bottom: string;
  border: string;
  fold: string;
}

const PALETTES: Record<FileCategory, Palette> = {
  audio: { top: "#9575ff", bottom: "#5e35b1", border: "#d1c4e9", fold: "#b39ddb" },
  video: { top: "#ff8a65", bottom: "#d84315", border: "#ffccbc", fold: "#ffab91" },
  file: { top: "#f7f9fa", bottom: "#dfe5ea", border: "#90a4ae", fold: "#b0bec5" },
};

function pagePath(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, h, r, fold } = PAGE;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - fold, y);
  ctx.lineTo(x + w, y + fold);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawPage(ctx: CanvasRenderingContext2D, palette: Palette): void {
  const { x, y, w, h, fold } = PAGE;
  const gradient = ctx.createLinearGradient(0, y, 0, y + h);
  gradient.addColorStop(0, palette.top);
  gradient.addColorStop(1, palette.bottom);
  pagePath(ctx);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = palette.border;
  ctx.lineJoin = "round";
  ctx.stroke();

  // 折れた角
  ctx.beginPath();
  ctx.moveTo(x + w - fold, y);
  ctx.lineTo(x + w - fold, y + fold);
  ctx.lineTo(x + w, y + fold);
  ctx.closePath();
  ctx.fillStyle = palette.fold;
  ctx.fill();
  ctx.stroke();
}

/** 拡張子のバッジ (ページの下寄りに置く小さなラベル)。 */
function drawBadge(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, fill: string, color: string, fontSize: number): void {
  ctx.font = `bold ${fontSize}px ${FONT}`;
  const width = Math.max(ctx.measureText(text).width + fontSize * 1.1, fontSize * 2.4);
  roundRect(ctx, cx - width / 2, cy - fontSize * 0.85, width, fontSize * 1.7, fontSize * 0.5);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy + fontSize * 0.04);
}

/** 音声: スピーカーと音波。 */
function drawAudioGlyph(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.save();
  ctx.translate(cx - 22, cy);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(-74, -38);
  ctx.lineTo(-30, -38);
  ctx.lineTo(34, -96);
  ctx.lineTo(34, 96);
  ctx.lineTo(-30, 38);
  ctx.lineTo(-74, 38);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 17;
  ctx.lineCap = "round";
  for (const [radius, alpha] of [[62, 1], [108, 0.8], [154, 0.6]] as const) {
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(34, 0, radius, -Math.PI / 4.2, Math.PI / 4.2);
    ctx.stroke();
  }
  ctx.restore();
}

/** 映像: 再生マークと、フィルムの穴。 */
function drawVideoGlyph(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  const { x, y, w, h, fold } = PAGE;
  // フィルムのコマ送りの穴 (左右の縁)
  ctx.fillStyle = "rgba(0, 0, 0, 0.26)";
  ctx.fillRect(x + 14, y + 40, 48, h - 80);
  ctx.fillRect(x + w - 62, y + fold + 14, 48, h - fold - 54);
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  for (let hy = y + 58; hy < y + h - 60; hy += 52) {
    roundRect(ctx, x + 26, hy, 24, 24, 6);
    ctx.fill();
    if (hy > y + fold + 20) {
      roundRect(ctx, x + w - 50, hy, 24, 24, 6);
      ctx.fill();
    }
  }
  // 再生マーク
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(cx - 40, cy - 84);
  ctx.lineTo(cx - 40, cy + 84);
  ctx.lineTo(cx + 98, cy);
  ctx.closePath();
  ctx.fill();
}

/** 汎用: 拡張子のバッジと、文章の行。 */
function drawFileGlyph(ctx: CanvasRenderingContext2D, label: string): void {
  drawBadge(ctx, label, PAGE.x + PAGE.w / 2 - 20, 172, "#455a64", "#ffffff", 64);
  ctx.fillStyle = "#b0bec5";
  const lines: [number, number][] = [[300, 0], [340, 0], [250, 0], [320, 0]];
  lines.forEach(([width], i) => {
    roundRect(ctx, 100, 268 + i * 42, width, 16, 8);
    ctx.fill();
  });
}

/** 幅に収まるように、名前を省略する。拡張子は残す (例: "very-long-na…me.pdf")。 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const dot = text.lastIndexOf(".");
  const tail = dot > 0 && text.length - dot <= 6 ? text.slice(dot) : "";
  const base = [...(tail ? text.slice(0, dot) : text)];
  while (base.length > 1) {
    base.pop();
    const candidate = `${base.join("")}…${tail}`;
    if (ctx.measureText(candidate).width <= maxWidth) return candidate;
  }
  return `…${tail}`;
}

function drawLabel(ctx: CanvasRenderingContext2D, name: string, size: number): void {
  const { x, y, w, h, r } = LABEL;
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = "rgba(18, 22, 30, 0.92)";
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold 54px ${FONT}`;
  ctx.fillText(fitText(ctx, name, w - 36), x + w / 2, y + h * 0.37);
  ctx.fillStyle = "#c5ced6";
  ctx.font = `bold 38px ${FONT}`;
  ctx.fillText(formatBytes(size), x + w / 2, y + h * 0.77);
}

export interface FileIconInfo {
  name: string;
  size: number;
  category: FileCategory;
}

/** canvas にファイルアイコンを描く (背景は透明)。 */
export function drawFileIcon(canvas: HTMLCanvasElement, { name, size, category }: FileIconInfo): void {
  canvas.width = ICON_CANVAS_WIDTH;
  canvas.height = ICON_CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawPage(ctx, PALETTES[category]);
  const cx = PAGE.x + PAGE.w / 2;
  const cy = PAGE.y + PAGE.h / 2 - 14;
  if (category === "audio") {
    drawAudioGlyph(ctx, cx, cy);
    drawBadge(ctx, iconLabel(name), cx, PAGE.y + PAGE.h - 52, "rgba(0, 0, 0, 0.28)", "#ffffff", 40);
  } else if (category === "video") {
    drawVideoGlyph(ctx, cx, cy);
    drawBadge(ctx, iconLabel(name), cx, PAGE.y + PAGE.h - 52, "rgba(0, 0, 0, 0.32)", "#ffffff", 40);
  } else {
    drawFileGlyph(ctx, iconLabel(name));
  }
  drawLabel(ctx, name, size);
}
