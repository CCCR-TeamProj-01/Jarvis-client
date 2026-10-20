# Jarvis Client

Windows와 macOS용 자비스 데스크톱 클라이언트입니다. Electron·React·TypeScript·pnpm 기반에 단일 인스턴스·트레이·호출 단축키·창 관리·검증된 UI IPC와 로그인/회원가입 화면 틀이 구현되어 있습니다. 실제 인증·음성 인식·제스처·서버 연결·OS 제어는 후속 구현입니다.

## 시작

Node.js 24 LTS(`.nvmrc`)와 pnpm 10이 필요합니다.

```bash
pnpm install
pnpm dev
```

앱은 로그인 화면으로 시작합니다. 창을 닫으면 트레이로 숨기고, 트레이 또는 기본 단축키 `CommandOrControl+Shift+Space`로 다시 엽니다. 앱 종료는 트레이나 화면의 종료 버튼을 사용합니다. 로그인/가입의 입력·제출은 인증 모듈 연결 전까지 비활성화되어 있습니다.

검사와 빌드:

```bash
pnpm typecheck
pnpm build
```

## 구조

- `src/main/application`: 앱 생명주기·트레이·단축키·창 관리
- `src/main/interaction`: Main 상태·화면·명령 처리
- `src/main/ipc`: 소유 UI 창과 입력을 검증하는 IPC 핸들러
- `src/preload`: UI·미디어 Renderer에 각각 노출할 제한된 API
- `src/renderer/ui`: 사용자 화면
- `src/renderer/media`: 센서 입력과 서버 TTS 오디오 재생용 별도 Renderer 진입점
- `src/workers`: 영상 추론 Worker 자리
- `src/inference`: 로컬 KWS·VAD 프로세스 어댑터 자리
- `src/main/speech`: 음성 세션과 서버 STT·TTS 연동 자리
- `src/shared/contracts`: 앱·인증·UI·센서·제스처·도구·로컬 음성 데이터와 검증 스키마
- `src/shared/ipc`: UI·Media Renderer의 제한된 공개 API 계약
- `docs`: 기능 명세, 아키텍처, 검증 계획

기능 구현 기준은 [문서 목차](docs/README.md)를 참고하세요. 클라이언트에는 STT·TTS 모델을 넣지 않으며 로컬 KWS·VAD 모델과 네이티브 실행 파일의 패키징 방식은 기술 검증 후 확정합니다.

모듈 간 코드 계약과 대역 주입 방법은 [클라이언트 공통 인터페이스](docs/architecture/client-interfaces.md)를 따릅니다. UI의 현재 Preload API는 platform·dispatch·getSnapshot·subscribe입니다. 전체 UiApi의 auth 영역과 미디어 제어는 실제 핸들러를 구현한 뒤 공개합니다.
