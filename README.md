# Jarvis Client

Windows와 macOS용 자비스 데스크톱 클라이언트입니다. Electron·React·TypeScript·pnpm 기반에 단일 인스턴스·트레이·호출 단축키·창 관리·검증된 UI IPC와 로그인/회원가입 화면 틀이 구현되어 있습니다. 실제 인증·음성 인식·제스처·서버 연결·OS 제어는 후속 구현입니다.

## 시작

Node.js 24 LTS(`.nvmrc`)와 pnpm 10이 필요합니다.

```bash
pnpm install
pnpm dev
```

앱은 로그인 화면으로 시작합니다. 창을 닫으면 트레이로 숨기고, 트레이 또는 기본 단축키 `CommandOrControl+Shift+Space`로 다시 엽니다. 앱 종료는 트레이나 화면의 종료 버튼을 사용합니다. 서버 연동 전에는 모든 인증 요청이 연결 불가로 실패합니다. 개발용 인증 대역으로 로그인·회원가입을 확인하려면 다음처럼 실행합니다(패키징된 앱에서는 동작하지 않습니다).

```bash
JARVIS_DEV_AUTH=1 pnpm dev   # 기본 계정: demo / demo1234
```

센서(카메라·마이크)는 로그인 후에만 쓸 수 있습니다. 실제 장치 없이 확인하려면 `JARVIS_FAKE_MEDIA=1`(가짜 장치), 소비 기능 없이 사용권 흐름을 보려면 `JARVIS_SENSOR_SELFTEST=1`(로그인 후 진단 사용권을 잡고 로그에 출력)을 함께 지정합니다. 둘 다 패키징된 앱에서는 동작하지 않습니다.

앱·OS 제어 도구는 서버 없이 `JARVIS_TOOL_SELFTEST='[{"requestId":"r1","executionId":"e1","command":{"tool":"apps.list","arguments":{}}}]'`처럼 도구 요청 JSON 배열을 주면 로그인 직후 실행하고 보고를 `TOOL_SELFTEST` 줄로 출력합니다(macOS에서 앱 도구 동작, 패키징된 앱에서는 동작하지 않음).

로컬 음성 처리에는 VAD 모델이 필요합니다. 처음 한 번 `pnpm models:fetch`로 `resources/models/`에 내려받습니다(`pnpm package`는 자동으로 실행). 마이크 없이 확인하려면 `JARVIS_FAKE_MEDIA=1 JARVIS_FAKE_AUDIO_FILE=<wav 경로> JARVIS_VOICE_SELFTEST=1`로 파일을 마이크 입력으로 쓰고 로그인하면, 찾은 발화의 위치와 길이를 `VOICE_SELFTEST` 줄로 출력합니다(패키징된 앱에서는 동작하지 않음).

음성 대화 전체를 서버 없이 보려면 위 가짜 마이크 설정에 `JARVIS_DEV_SPEECH=1`을 더하면 서버 대역이 인식·응답·효과음을 대신하고, 화면의 `대화 시작`(음성) 또는 입력창(글)으로 시작합니다(`JARVIS_SPEECH_SELFTEST=1`이면 로그인 직후 자동으로 시작해 상태 변화를 `SPEECH_SELFTEST` 줄로 출력). 패키징된 앱에서는 동작하지 않습니다.

VS Code 터미널에서 `ELECTRON_RUN_AS_NODE`가 설정돼 있으면 앱이 실행되지 않으니 해제하고 실행하세요. 인증 동작 기준은 [계정 인증](docs/features/auth.md)을 따릅니다.

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

현재 인증 화면은 [Frosted Pearl 디자인 시스템](docs/design/design-system.md)을 따릅니다. 시각 토큰은 `src/renderer/ui/tokens.css`에서 공유하고 Pretendard·Inter 글꼴과 Lucide 아이콘은 앱에 포함합니다.

기본 실행은 밝은 불투명 네이티브 창과 앱 내부의 CSS 반투명 패널을 사용합니다. Vibrancy·Acrylic은 실제 창 외관에 문제가 확인되어 기본 비활성 상태이며, 개발 환경에서 `JARVIS_NATIVE_WINDOW_EFFECTS=1`을 지정한 경우에만 검증할 수 있습니다. 패키지 빌드에서는 이 실험 옵션을 적용하지 않습니다.

모듈 간 코드 계약과 대역 주입 방법은 [클라이언트 공통 인터페이스](docs/architecture/client-interfaces.md)를 따릅니다. UI의 현재 Preload API는 platform·dispatch·getSnapshot·subscribe입니다. 전체 UiApi의 auth 영역과 미디어 제어는 실제 핸들러를 구현한 뒤 공개합니다.
