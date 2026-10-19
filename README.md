# Jarvis Client

Windows와 macOS용 자비스 데스크톱 클라이언트입니다. 현재는 Electron·React·TypeScript·pnpm 기반 실행 골격과 문서 구조만 구성되어 있습니다. 음성 인식, 제스처, 서버 연결, OS 제어는 아직 구현되지 않았습니다.

## 시작

Node.js 24 LTS(`.nvmrc`)와 pnpm 10이 필요합니다.

```bash
pnpm install
pnpm dev
```

검사와 빌드:

```bash
pnpm typecheck
pnpm build
```

## 구조

- `src/main`: Electron 생명주기와 실행 권한의 원본
- `src/preload`: UI·미디어 Renderer에 각각 노출할 제한된 API
- `src/renderer/ui`: 사용자 화면
- `src/renderer/media`: 센서 입력과 서버 TTS 오디오 재생용 별도 Renderer 진입점
- `src/workers`: 영상 추론 Worker 자리
- `src/inference`: 로컬 KWS·VAD 프로세스 어댑터 자리
- `src/main/speech`: 음성 세션과 서버 STT·TTS 연동 자리
- `src/shared/contracts`: UI·센서·제스처·도구·로컬 음성 데이터와 검증 스키마
- `src/shared/ipc`: UI·Media Renderer의 제한된 공개 API 계약
- `docs`: 기능 명세, 아키텍처, 검증 계획

기능 구현 기준은 [문서 목차](docs/README.md)를 참고하세요. 클라이언트에는 STT·TTS 모델을 넣지 않으며 로컬 KWS·VAD 모델과 네이티브 실행 파일의 패키징 방식은 기술 검증 후 확정합니다.

모듈 간 코드 계약과 대역 주입 방법은 [클라이언트 공통 인터페이스](docs/architecture/client-interfaces.md)를 따릅니다. 현재 공개된 Preload API는 platform 조회이며, 전체 IPC 메서드는 핸들러 구현 시 노출합니다.
