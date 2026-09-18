# sc-inter — 웹 1대1 온라인 미니 축구

브라우저만 있으면 두 사람이 같은 경기를 실시간으로 즐길 수 있는 미니 축구 게임이다.
방을 만들면 6자리 코드와 초대 링크가 나오고, 상대가 접속하면 바로 킥오프한다.

## 빠른 시작

```bash
pnpm install
pnpm build          # 웹 번들 + 서버 컴파일
PORT=8787 pnpm start
# http://localhost:8787
```

개발 중에는 두 프로세스를 따로 띄운다.

```bash
pnpm dev:api        # 8787 포트, WebSocket + API
pnpm dev            # 5175 포트, Vite 개발 서버 (ws 는 8787 로 프록시)
```

## 조작

| 동작 | 키 |
| --- | --- |
| 이동 | `W` `A` `S` `D` 또는 방향키 |
| 슛·패스 | `Space` (길게 누르면 강하게) |
| 모바일 | 왼쪽 조이스틱 + 오른쪽 슛 버튼 |

## 구성

- `app/api` — Node 22 + TypeScript. 60Hz 권위 시뮬레이션, 20Hz 상태 브로드캐스트, 정적 웹 서빙, `/healthz`, graceful shutdown.
- `app/web` — React 19 + Vite + Canvas 2D 렌더러.

자세한 내용은 [`AGENTS.md`](AGENTS.md) 와 [`docs/`](docs/) 를 참고한다.
