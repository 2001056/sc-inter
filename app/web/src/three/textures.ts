/**
 * 필요한 그림을 전부 캔버스로 직접 그린다.
 *
 * 외부 CDN 이나 이미지 파일에 기대지 않는 것이 이 프로젝트의 규칙이라, 잔디 줄무늬,
 * 라인 마킹, 유니폼, 공, 골네트, 관중석을 모두 런타임에 만들어 텍스처로 올린다.
 * 번들에 바이너리가 하나도 들어가지 않고, 팀 색을 바꾸면 그 자리에서 다시 그려진다.
 */
import * as THREE from "three";

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  const ctx = element.getContext("2d");
  if (!ctx) throw new Error("2D 캔버스를 만들 수 없습니다.");
  return [element, ctx];
}

function finish(element: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(element);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

/** 잔디 위에 얼룩과 잔결을 얹어 단색으로 보이지 않게 한다. */
function grassNoise(ctx: CanvasRenderingContext2D, w: number, h: number, alpha: number): void {
  ctx.save();
  for (let i = 0; i < 9000; i += 1) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const l = 2 + Math.random() * 7;
    ctx.strokeStyle = `rgba(${Math.random() < 0.5 ? "255,255,255" : "0,0,0"},${alpha * Math.random()})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 3, y + l);
    ctx.stroke();
  }
  ctx.restore();
}

export interface PitchMarkings {
  length: number;
  width: number;
  goalWidth: number;
}

/**
 * 경기장 바닥 한 장. 줄무늬 잔디와 흰 라인을 한 텍스처에 같이 굽는다.
 * 라인을 별도 메시로 띄우면 z-fighting 이 생기고, 텍스처에 넣으면 그럴 일이 없다.
 */
export function pitchTexture(m: PitchMarkings): THREE.CanvasTexture {
  const pxPerMeter = 48;
  const w = Math.round(m.length * pxPerMeter);
  const h = Math.round(m.width * pxPerMeter);
  const [element, ctx] = canvas(w, h);

  // 세로 줄무늬 잔디(잔디깎이 자국).
  const stripes = 12;
  for (let i = 0; i < stripes; i += 1) {
    ctx.fillStyle = i % 2 === 0 ? "#2f7a3f" : "#296d38";
    ctx.fillRect((i * w) / stripes, 0, w / stripes + 1, h);
  }
  grassNoise(ctx, w, h, 0.16);

  // 가장자리를 살짝 어둡게 해 평평한 느낌을 줄인다.
  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, w * 0.62);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.28)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  const line = Math.max(3, Math.round(0.12 * pxPerMeter));
  ctx.strokeStyle = "rgba(255,255,255,0.88)";
  ctx.lineWidth = line;
  const inset = line;

  // 터치라인·골라인.
  ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);

  // 하프웨이 라인과 센터 서클.
  ctx.beginPath();
  ctx.moveTo(w / 2, inset);
  ctx.lineTo(w / 2, h - inset);
  ctx.stroke();
  const centerRadius = Math.min(h * 0.18, w * 0.09);
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, centerRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, line * 0.9, 0, Math.PI * 2);
  ctx.fill();

  // 페널티 구역과 골 구역. 골문 폭을 기준으로 잡아 경기장 크기가 바뀌어도 비율이 맞는다.
  const goalPx = m.goalWidth * pxPerMeter;
  const boxDepth = Math.min(w * 0.16, goalPx * 2.2);
  const boxHeight = Math.min(h * 0.72, goalPx * 3.0);
  const smallDepth = boxDepth * 0.42;
  const smallHeight = goalPx * 1.8;
  for (const side of [0, 1]) {
    const x = side === 0 ? inset : w - inset;
    const dir = side === 0 ? 1 : -1;
    ctx.strokeRect(
      Math.min(x, x + dir * boxDepth),
      (h - boxHeight) / 2,
      boxDepth,
      boxHeight,
    );
    ctx.strokeRect(
      Math.min(x, x + dir * smallDepth),
      (h - smallHeight) / 2,
      smallDepth,
      smallHeight,
    );
    // 페널티 스폿과 아크.
    const spotX = x + dir * boxDepth * 0.62;
    ctx.beginPath();
    ctx.arc(spotX, h / 2, line * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    const arcR = centerRadius * 0.86;
    const start = side === 0 ? -Math.PI / 2.6 : Math.PI - Math.PI / 2.6;
    ctx.arc(x + dir * boxDepth, h / 2, arcR, start, start + Math.PI / 1.3, side === 1);
    ctx.stroke();
  }

  // 코너 아크.
  const cornerR = Math.max(10, 0.9 * pxPerMeter);
  const corners: [number, number, number][] = [
    [inset, inset, 0],
    [w - inset, inset, Math.PI / 2],
    [w - inset, h - inset, Math.PI],
    [inset, h - inset, -Math.PI / 2],
  ];
  for (const [cx, cy, rot] of corners) {
    ctx.beginPath();
    ctx.arc(cx, cy, cornerR, rot, rot + Math.PI / 2);
    ctx.stroke();
  }

  return finish(element);
}

export interface KitColors {
  /** 상의 바탕색 */
  jersey: string;
  /** 소매·칼라·줄무늬에 쓰는 보조색 */
  accent: string;
  shorts: string;
  socks: string;
  boots: string;
}

export const KITS: Record<"left" | "right", KitColors> = {
  left: { jersey: "#1b4fd8", accent: "#eef2ff", shorts: "#12225c", socks: "#1b4fd8", boots: "#f4f6ff" },
  right: { jersey: "#e23b3b", accent: "#fff2f2", shorts: "#2a0f12", socks: "#e23b3b", boots: "#12161f" },
};

/**
 * 상의 텍스처. u 는 몸 둘레(0.75 가 등 한가운데), v 는 아래에서 위로 향한다.
 * 등에 번호, 가슴에 팀 마크, 아래에 허리 밴드를 그린다.
 */
export function jerseyTexture(kit: KitColors, number: number): THREE.CanvasTexture {
  const w = 1024;
  const h = 512;
  const [element, ctx] = canvas(w, h);

  ctx.fillStyle = kit.jersey;
  ctx.fillRect(0, 0, w, h);

  // 세로 줄무늬를 옅게 넣어 단색 천으로 보이지 않게 한다.
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = kit.accent;
  for (let i = 0; i < 10; i += 1) ctx.fillRect((i * w) / 10, 0, w / 24, h);
  ctx.globalAlpha = 1;

  // 칼라. 몸통 맨 위 링에만 닿도록 아주 얇게 둔다(두꺼우면 목에 흰 판처럼 보인다).
  ctx.fillStyle = kit.accent;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(0, 0, w, h * 0.018);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(0, h * 0.018, w, h * 0.012);

  // 허리 밴드(텍스처 아래쪽).
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(0, h * 0.93, w, h * 0.07);

  // 등번호. v 가 위로 갈수록 1 이므로 위쪽 절반에 큼직하게.
  ctx.save();
  ctx.translate(w * 0.75, h * 0.46);  // 등
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(h * 0.42)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.fillStyle = kit.accent;
  // 원통 UV 는 u 가 커질수록 화면 왼쪽으로 감기므로 좌우를 뒤집어 그려야 바로 읽힌다.
  ctx.scale(-1, -1);
  ctx.strokeText(String(number), 0, 0);
  ctx.fillText(String(number), 0, 0);
  ctx.restore();

  // 가슴 쪽(u=0.25)에는 작은 마크.
  ctx.save();
  ctx.translate(w * 0.25, h * 0.62);  // 가슴
  ctx.scale(-1, -1);
  ctx.fillStyle = kit.accent;
  ctx.font = `700 ${Math.round(h * 0.1)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("R", 0, 0);
  ctx.restore();

  return finish(element);
}

/** 반바지: 옆선 한 줄만 있는 단순한 천. */
export function shortsTexture(kit: KitColors): THREE.CanvasTexture {
  const [element, ctx] = canvas(256, 256);
  ctx.fillStyle = kit.shorts;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = kit.accent;
  ctx.globalAlpha = 0.8;
  ctx.fillRect(0, 0, 8, 256);
  ctx.fillRect(128, 0, 8, 256);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(0,0,0,0.2)";
  ctx.fillRect(0, 0, 256, 18);
  return finish(element);
}

/** 축구공: 흰 바탕에 검은 오각형과 바느질선. */
export function ballTexture(): THREE.CanvasTexture {
  const size = 512;
  const [element, ctx] = canvas(size, size);
  ctx.fillStyle = "#f7f8fa";
  ctx.fillRect(0, 0, size, size);

  const drawPatch = (cx: number, cy: number, r: number, sides: number, rot: number) => {
    ctx.beginPath();
    for (let i = 0; i <= sides; i += 1) {
      const a = rot + (i / sides) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r * 0.9;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  };

  ctx.fillStyle = "#16181d";
  // 적도 근처에 오각형을 둘러 배치하고 위아래에 하나씩 둔다.
  const equator: [number, number][] = [
    [size * 0.1, size * 0.5],
    [size * 0.3, size * 0.34],
    [size * 0.5, size * 0.5],
    [size * 0.7, size * 0.34],
    [size * 0.9, size * 0.5],
    [size * 0.2, size * 0.68],
    [size * 0.4, size * 0.82],
    [size * 0.6, size * 0.68],
    [size * 0.8, size * 0.82],
    [size * 0.4, size * 0.14],
    [size * 0.85, size * 0.14],
  ];
  equator.forEach(([x, y], i) => drawPatch(x, y, size * 0.075, 5, i * 0.7));

  // 바느질선.
  ctx.strokeStyle = "rgba(60,64,72,0.35)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 26; i += 1) {
    ctx.beginPath();
    ctx.moveTo(Math.random() * size, Math.random() * size);
    ctx.lineTo(Math.random() * size, Math.random() * size);
    ctx.stroke();
  }
  return finish(element);
}

/** 골네트의 그물코. 알파맵으로만 쓰므로 흑백이다. */
export function netAlphaTexture(): THREE.CanvasTexture {
  const size = 256;
  const [element, ctx] = canvas(size, size);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  const cells = 16;
  for (let i = 0; i <= cells; i += 1) {
    const p = (i / cells) * size;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  const texture = finish(element, false);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** 관중석. 알록달록한 점을 뿌려 멀리서 사람처럼 보이게 한다. */
export function crowdTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const [element, ctx] = canvas(w, h);
  ctx.fillStyle = "#11161d";
  ctx.fillRect(0, 0, w, h);
  const palette = ["#e8e8ef", "#2b4fb0", "#c93b3b", "#d8a63a", "#3b8f57", "#7c4bbd", "#1f2733"];
  for (let i = 0; i < 5200; i += 1) {
    ctx.fillStyle = palette[Math.floor(Math.random() * palette.length)]!;
    ctx.globalAlpha = 0.5 + Math.random() * 0.5;
    ctx.beginPath();
    ctx.arc(Math.random() * w, Math.random() * h, 1.6 + Math.random() * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // 위쪽은 어둡게 해 조명이 아래로 떨어지는 느낌을 준다.
  const shade = ctx.createLinearGradient(0, 0, 0, h);
  shade.addColorStop(0, "rgba(0,0,0,0.55)");
  shade.addColorStop(1, "rgba(0,0,0,0.05)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, w, h);
  const texture = finish(element);
  texture.wrapS = THREE.RepeatWrapping;
  texture.repeat.set(8, 1);
  return texture;
}

/** 선수 발밑에 깔 부드러운 그림자 원판. 그림자 맵을 못 쓰는 상황의 보조다. */
export function blobShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const [element, ctx] = canvas(size, size);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(0,0,0,0.55)");
  gradient.addColorStop(0.55, "rgba(0,0,0,0.25)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return finish(element, false);
}
