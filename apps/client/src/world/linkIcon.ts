import { ICON_CANVAS_HEIGHT, ICON_CANVAS_WIDTH } from "./fileIcon";

const FONT = '"Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif';
const PAGE = { x: 40, y: 24, w: 432, h: 470, r: 28 };

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** URL を、ページの幅に収まるように折り返す。 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const char of text) {
    const next = line + char;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = char;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && (line.length > 0 || text.length > lines.join("").length)) {
    // 収まらないときは、最後の行に省略記号を付ける
    const last = lines[maxLines - 1]!;
    let truncated = last;
    while (truncated.length > 1 && ctx.measureText(`${truncated}…`).width > maxWidth) truncated = truncated.slice(0, -1);
    lines[maxLines - 1] = `${truncated}…`;
  }
  return lines;
}

/** リンクのカード (2D canvas)。3D 空間の板に貼るテクスチャになる。 */
export function drawLinkIcon(canvas: HTMLCanvasElement, url: string): void {
  canvas.width = ICON_CANVAS_WIDTH;
  canvas.height = ICON_CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // カード
  const gradient = ctx.createLinearGradient(0, PAGE.y, 0, PAGE.y + PAGE.h);
  gradient.addColorStop(0, "#eef5fb");
  gradient.addColorStop(1, "#dce7f2");
  roundRect(ctx, PAGE.x, PAGE.y, PAGE.w, PAGE.h, PAGE.r);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#8aa9c4";
  ctx.stroke();

  // リンクの絵 (二つの輪)
  const cx = PAGE.x + PAGE.w / 2;
  ctx.save();
  ctx.translate(cx, PAGE.y + 92);
  ctx.rotate(-Math.PI / 4);
  ctx.lineWidth = 13;
  ctx.strokeStyle = "#3d7fb8";
  ctx.lineCap = "round";
  for (const dx of [-26, 26]) {
    roundRect(ctx, dx - 34, -20, 68, 40, 20);
    ctx.stroke();
  }
  ctx.restore();

  // URL
  ctx.fillStyle = "#1d2c3a";
  ctx.font = `600 22px ${FONT}`;
  ctx.textBaseline = "top";
  const lines = wrap(ctx, url, PAGE.w - 56, 8);
  let y = PAGE.y + 162;
  for (const line of lines) {
    ctx.fillText(line, PAGE.x + 28, y);
    y += 30;
  }

  // 下の帯
  ctx.fillStyle = "rgba(61, 127, 184, 0.14)";
  roundRect(ctx, PAGE.x + 24, PAGE.y + PAGE.h - 74, PAGE.w - 48, 50, 14);
  ctx.fill();
  ctx.fillStyle = "#2b5f8c";
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText("リンク", PAGE.x + 40, PAGE.y + PAGE.h - 62);

  // 文字がはみ出さないよう、ページで切り抜く
  ctx.globalCompositeOperation = "destination-in";
  roundRect(ctx, PAGE.x, PAGE.y, PAGE.w, PAGE.h, PAGE.r);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}
