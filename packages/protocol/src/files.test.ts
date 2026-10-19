import { describe, expect, it } from "vitest";
import {
  MAX_FILE_NAME_LENGTH,
  classifyFile,
  extensionOf,
  formatBytes,
  iconLabel,
  imageExtension,
  mediaType,
  sanitizeFileName,
  sniffMediaKind,
} from "./files.js";

const bytes = (...v: (number | string)[]) =>
  Uint8Array.from(v.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));

describe("extensionOf", () => {
  it("returns the lower-case extension without the dot", () => {
    expect(extensionOf("Song.MP3")).toBe("mp3");
    expect(extensionOf("a.tar.gz")).toBe("gz");
  });
  it("returns empty for no / odd extensions", () => {
    expect(extensionOf("README")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("name.")).toBe("");
    expect(extensionOf("file.with space")).toBe("");
    expect(extensionOf("x.waytoolongextension")).toBe("");
  });
});

describe("sanitizeFileName", () => {
  it("keeps ordinary names (including non-ASCII)", () => {
    expect(sanitizeFileName("report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("日本語 のファイル.txt")).toBe("日本語 のファイル.txt");
  });
  it("replaces path separators and reserved characters", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(sanitizeFileName('a:b*c?"d<e>f|g.txt')).toBe("a_b_c__d_e_f_g.txt");
    expect(sanitizeFileName("C:\\Users\\me\\x.exe")).toBe("C__Users_me_x.exe");
  });
  it("strips control, zero-width and bidi override characters (extension spoofing)", () => {
    // "photo\u202Egpj.exe" は表示上 "photoexe.jpg" に見える
    expect(sanitizeFileName("photo\u202Egpj.exe")).toBe("photogpj.exe");
    expect(sanitizeFileName("a\u0000b\u200bc\n.txt")).toBe("abc.txt");
  });
  it("removes leading dots and trailing dots / spaces", () => {
    expect(sanitizeFileName("..hidden")).toBe("hidden");
    expect(sanitizeFileName("name. . ")).toBe("name");
  });
  it("falls back for empty / non-string input", () => {
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("   ")).toBe("file");
    expect(sanitizeFileName("...")).toBe("file");
    expect(sanitizeFileName(42)).toBe("file");
    expect(sanitizeFileName(undefined, "unnamed")).toBe("unnamed");
  });
  it("truncates long names but keeps the extension", () => {
    const name = sanitizeFileName(`${"a".repeat(300)}.pdf`);
    expect([...name]).toHaveLength(MAX_FILE_NAME_LENGTH);
    expect(name.endsWith(".pdf")).toBe(true);
  });
  it("does not split surrogate pairs when truncating", () => {
    const name = sanitizeFileName("😀".repeat(200));
    expect([...name]).toHaveLength(MAX_FILE_NAME_LENGTH);
    expect(name).toBe("😀".repeat(MAX_FILE_NAME_LENGTH));
  });
});

describe("classifyFile", () => {
  it("classifies by extension", () => {
    expect(classifyFile("a.mp3")).toBe("audio");
    expect(classifyFile("a.FLAC")).toBe("audio");
    expect(classifyFile("movie.mp4")).toBe("video");
    expect(classifyFile("clip.WEBM")).toBe("video");
    expect(classifyFile("doc.pdf")).toBe("file");
    expect(classifyFile("main.ts")).toBe("file"); // TypeScript は映像ではない
  });
  it("trusts the extension over the content", () => {
    expect(classifyFile("fake.mp3", bytes("%PDF-1.7"))).toBe("audio");
  });
  it("falls back to the content when the extension is unknown or missing", () => {
    expect(classifyFile("noext", bytes("OggS", 0, 2))).toBe("audio");
    expect(classifyFile("weird.bin", bytes(0, 0, 0, 24, "ftypisom"))).toBe("video");
    expect(classifyFile("data.dat", bytes("hello world"))).toBe("file");
  });
});

describe("sniffMediaKind", () => {
  it("detects audio containers", () => {
    expect(sniffMediaKind(bytes("ID3", 4, 0))).toBe("audio");
    expect(sniffMediaKind(bytes(0xff, 0xfb, 0x90, 0))).toBe("audio");
    expect(sniffMediaKind(bytes("RIFF", 0, 0, 0, 0, "WAVE", "fmt "))).toBe("audio");
    expect(sniffMediaKind(bytes("OggS", 0))).toBe("audio");
    expect(sniffMediaKind(bytes("fLaC", 0))).toBe("audio");
    expect(sniffMediaKind(bytes("FORM", 0, 0, 0, 0, "AIFF"))).toBe("audio");
    expect(sniffMediaKind(bytes("MThd", 0))).toBe("audio");
    expect(sniffMediaKind(bytes(0, 0, 0, 24, "ftypM4A ", 0))).toBe("audio");
  });
  it("detects video containers", () => {
    expect(sniffMediaKind(bytes(0x1a, 0x45, 0xdf, 0xa3, 0))).toBe("video");
    expect(sniffMediaKind(bytes("RIFF", 0, 0, 0, 0, "AVI ", "LIST"))).toBe("video");
    expect(sniffMediaKind(bytes(0, 0, 0, 24, "ftypmp42", 0))).toBe("video");
    expect(sniffMediaKind(bytes(0, 0, 0, 20, "ftypqt  ", 0))).toBe("video");
  });
  it("returns file for everything else, including short / empty input", () => {
    expect(sniffMediaKind(bytes("%PDF-1.7"))).toBe("file");
    expect(sniffMediaKind(bytes(0x89, "PNG"))).toBe("file");
    expect(sniffMediaKind(new Uint8Array())).toBe("file");
    expect(sniffMediaKind(bytes(0xff))).toBe("file");
  });
});

describe("iconLabel / formatBytes", () => {
  it("labels with the upper-case extension (max 4 chars)", () => {
    expect(iconLabel("report.pdf")).toBe("PDF");
    expect(iconLabel("backup.tar.gz")).toBe("GZ");
    expect(iconLabel("a.markdown")).toBe("MARK");
    expect(iconLabel("README")).toBe("FILE");
  });
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatBytes(-1)).toBe("?");
  });
});

describe("imageExtension", () => {
  it("detects the supported image formats", () => {
    expect(imageExtension(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a))).toBe("png");
    expect(imageExtension(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("jpg");
    expect(imageExtension(bytes("GIF89a"))).toBe("gif");
    expect(imageExtension(bytes("GIF87a"))).toBe("gif");
    expect(imageExtension(bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 "))).toBe("webp");
  });
  it("returns empty otherwise", () => {
    expect(imageExtension(bytes("%PDF-1.7"))).toBe("");
    expect(imageExtension(bytes("RIFF", 0, 0, 0, 0, "WAVEfmt "))).toBe("");
    expect(imageExtension(new Uint8Array())).toBe("");
  });
});

describe("mediaType", () => {
  it("returns the Content-Type from the extension", () => {
    expect(mediaType("clip.webm")).toBe("video/webm");
    expect(mediaType("MOVIE.MP4")).toBe("video/mp4");
    expect(mediaType("song.mp3")).toBe("audio/mpeg");
  });
  it("falls back to application/octet-stream", () => {
    expect(mediaType("no-extension")).toBe("application/octet-stream");
    expect(mediaType("weird.xyz")).toBe("application/octet-stream");
  });
});
