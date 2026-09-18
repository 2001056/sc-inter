# HANDOFF

최신 인계 기록은 [`docs/핸드오프/202609/`](docs/핸드오프/202609/) 에 날짜별로 쌓는다.
이 파일은 "지금 이 저장소를 처음 여는 사람이 알아야 할 것"만 요약한다.

## 지금 상태 (2026-09-18)

| 영역 | 상태 |
| --- | --- |
| `app/api` (서버) | 3대3 권위 시뮬레이션·WebSocket·정적 서빙·health·graceful shutdown 완성. 테스트 82개 통과 |
| `app/web` (3D 화면) | 로비·3D 경기 화면 동작. 선수 메시 품질 보완 진행 중 |
| 통합 | 단일 프로세스(8787)로 웹+WebSocket 서빙, 두 브라우저 E2E 통과, Docker 이미지 기동 확인. **증거는 `ed6418e` 빌드 기준이며 프런트 수정 후 다시 받아야 한다** |
| 배포 구성 | `Dockerfile`, `compose.yaml` 준비. 실제 배포·공개 터널은 **미실행(사람 승인 대기)** |
| 저장소 | `github.com/2001056/sc-inter` `main` 에 기능 단위로 push |

## 먼저 읽을 것

1. [`AGENTS.md`](AGENTS.md) — 규칙과 승인 경계
2. [`docs/기획/게임규칙.md`](docs/기획/게임규칙.md) — 무엇을 만드는 게임인지
3. [`docs/백엔드/실시간계약.md`](docs/백엔드/실시간계약.md) — 서버·프런트 공동 계약(원본 타입은 `app/api/src/protocol.ts`)
4. [`docs/운영/실행과배포.md`](docs/운영/실행과배포.md) — 실행·개발 서버 관리·배포 준비

## 빨리 돌려보기

```bash
pnpm install
pnpm build
PORT=8787 pnpm start     # http://localhost:8787
```

## 남은 배포 단계 (사람 승인 필요 — 아직 실행 안 함)

1. **임시 공개**: `cloudflared tunnel --url http://localhost:8787` — 한 줄이면 되고, 열리는 것은 이 게임의 8787 포트 하나뿐이다. 도구는 설치해 두었다(2026.9.1). Ctrl-C 로 주소가 사라진다.
2. **또는 컨테이너 배포**: `docker build -t sc-inter . && docker run -p 8787:8787 sc-inter` → `/healthz` 확인
3. 리버스 프록시를 쓸 경우 WebSocket 업그레이드 헤더(`Upgrade`, `Connection`) 통과 설정
4. 공개 주소로 두 브라우저 최종 확인

자세한 내용과 주의점은 [`docs/운영/실행과배포.md`](docs/운영/실행과배포.md) 에 있다.
