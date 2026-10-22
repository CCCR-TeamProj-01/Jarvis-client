# Jarvis Client

Windows와 macOS용 자비스 데스크톱 클라이언트입니다. Electron·React·TypeScript·pnpm 기반에 단일 인스턴스·트레이·호출 단축키·창 관리·검증된 UI IPC와 로그인/회원가입 화면 틀이 구현되어 있습니다. 실제 인증·음성 인식·제스처·서버 연결·OS 제어는 후속 구현입니다.

## 시작

Node.js 24 LTS(`.nvmrc`)와 pnpm 10이 필요합니다.

```bash
pnpm install
pnpm dev
```

## 환경변수

개발용 설정(서버 주소, 개발용 대역, 가짜 마이크·카메라, 자체 시험)은 환경변수로 지정하며 전체 목록과 설명은 [.env.example](.env.example)에 있습니다. `cp .env.example .env`로 복사해 쓰면 개발 실행(`pnpm dev`)이 `.env`를 읽습니다. 패키징된 앱은 이 파일도, 이 환경변수도 쓰지 않습니다(서버 주소 변수도 무시합니다). 설치본의 서버 주소는 패키징할 때 `MAIN_VITE_JARVIS_SERVER_URL=https://… pnpm package`로 앱 코드에 넣으며, 주소가 없거나 `https`가 아니거나 이 PC를 가리키면 패키징이 시작 전에 중단되고, 빌드 뒤에도 주소가 실제로 들어갔는지 확인합니다. 셸에서 지정한 값(`JARVIS_SERVER_URL=… pnpm dev`)이 `.env`보다 우선합니다. VS Code 터미널에서 앱이 일반 Node로 실행되는 경우에는 `env -u ELECTRON_RUN_AS_NODE pnpm dev`로 실행합니다.

앱은 로그인 화면으로 시작합니다. 창을 닫으면 트레이로 숨기고, 트레이 또는 기본 단축키 `CommandOrControl+Shift+Space`로 다시 엽니다. 앱 종료는 트레이나 화면의 종료 버튼을 사용합니다. 서버 연동 전에는 모든 인증 요청이 연결 불가로 실패합니다. 개발용 인증 대역으로 로그인·회원가입을 확인하려면 다음처럼 실행합니다(패키징된 앱에서는 동작하지 않습니다).

```bash
JARVIS_DEV_AUTH=1 pnpm dev   # 기본 계정: demo / demo1234
# 로그인 비밀번호는 1~128자라 demo1234로 로그인할 수 있고, 새로 가입하는 비밀번호는 15자 이상(아이디는 영문·숫자·_ 3~32자)
```

서버 주소는 패키징되지 않은 앱에서 `JARVIS_SERVER_URL=http://127.0.0.1:8000/api/v1`처럼 지정합니다(`https` 또는 같은 PC의 `http`만 허용). 주소가 유효하면 로그인·가입이 서버 인증을, 글과 음성 대화가 서버의 대화·요청·음성 API를 사용하고, 서버가 이 기기에 내린 명령(앱·폴더·주소 열기, 볼륨·음소거)을 받아 실행해 결과를 보고합니다(`JARVIS_DEV_AUTH=1`이면 로그인이, `JARVIS_DEV_SPEECH=1`이면 대화·음성이 개발용 대역으로 바뀌고, 개발용 로그인에서는 명령을 받지 않습니다). 자세한 동작과 한계는 [서버 연동과 실행 계약](docs/architecture/server-integration.md)을 봅니다. 아이디 중복 확인도 서버(`POST /auth/username-checks`)에 묻고, 최종 판정은 가입 때 합니다.

센서(카메라·마이크)는 로그인 후에만 쓸 수 있습니다. 실제 장치 없이 확인하려면 `JARVIS_FAKE_MEDIA=1`(가짜 장치), 소비 기능 없이 사용권 흐름을 보려면 `JARVIS_SENSOR_SELFTEST=1`(로그인 후 진단 사용권을 잡고 로그에 출력)을 함께 지정합니다. 둘 다 패키징된 앱에서는 동작하지 않습니다.

앱·OS 제어 도구는 서버 없이 `JARVIS_TOOL_SELFTEST='[{"requestId":"r1","executionId":"e1","command":{"tool":"apps.list","arguments":{}}}]'`처럼 도구 요청 JSON 배열을 주면 로그인 직후 실행하고 보고를 `TOOL_SELFTEST` 줄로 출력합니다(macOS에서 앱 도구 동작, 패키징된 앱에서는 동작하지 않음).

로컬 음성 처리에는 VAD 모델이 필요합니다. 처음 한 번 `pnpm models:fetch`로 `resources/models/`에 내려받습니다(`pnpm package`는 자동으로 실행). 마이크 없이 확인하려면 `JARVIS_FAKE_MEDIA=1 JARVIS_FAKE_AUDIO_FILE=<wav 경로> JARVIS_VOICE_SELFTEST=1`로 파일을 마이크 입력으로 쓰고 로그인하면, 찾은 발화의 위치와 길이를 `VOICE_SELFTEST` 줄로 출력합니다(패키징된 앱에서는 동작하지 않음).

손 인식에는 `hand_landmarker.task` 모델이 필요하며 `pnpm models:fetch`가 함께 내려받습니다. 카메라 없이 확인하려면 `JARVIS_FAKE_MEDIA=1 JARVIS_FAKE_VIDEO_FILE=<y4m 또는 mjpeg 경로> JARVIS_HAND_SELFTEST=5`로 영상 파일을 카메라 입력으로 쓰고 로그인하면, 5초 동안 인식한 손 관절 요약을 `HAND_SELFTEST` 줄로 출력합니다(`JARVIS_HAND_SELFTEST=0`이면 로그아웃·종료까지 계속 추적)(패키징된 앱에서는 동작하지 않음).

음성·제스처·실행 결과는 화면 위의 작은 상태 알약(오버레이)으로도 보입니다. 개발 중에 끄려면 `JARVIS_NO_OVERLAY=1`을 지정합니다(패키징된 앱에서는 항상 켜짐).

손으로 커서를 움직이려면 로그인 후 화면의 `제스처 시작`(또는 단축키 `⌘ ⇧ G` / `Ctrl Shift G`, 트레이 메뉴)을 누릅니다. macOS는 처음에 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 자비스(개발 중에는 Electron 또는 터미널 앱)를 허용해야 하며, 허용한 뒤 다시 시작합니다. 검지만 펴서 가리키면 커서가 움직이고(주먹·편 손에서는 멈춤), 그 자세에서 엄지와 검지를 모으면 클릭합니다. 실제 커서를 움직이지 않고 확인하려면 `JARVIS_FAKE_POINTER=1`을 더하면 입력 내용을 `POINTER_FAKE` 줄로 출력합니다(패키징된 앱에서는 동작하지 않음).

서버 대역(`JARVIS_DEV_SPEECH=1`)은 글·음성 입력으로 도구도 부릅니다. 입력창에 `앱 목록 알려줘`, `사파리 열어줘`, `유튜브 열어줘`, `이전 작업으로 돌아가줘`를 입력하면 실제 앱 제어(macOS)를 거쳐 `실행: …` 결과와 응답이 표시됩니다(`사파리 열어줘`는 실제로 앱이 실행됩니다).

음성 대화 전체를 서버 없이 보려면 위 가짜 마이크 설정에 `JARVIS_DEV_SPEECH=1`을 더하면 서버 대역이 인식·응답·효과음을 대신하고, 화면의 `대화 시작`(음성) 또는 입력창(글)으로 시작합니다(`JARVIS_SPEECH_SELFTEST=1`이면 로그인 직후 자동으로 시작해 상태 변화를 `SPEECH_SELFTEST` 줄로 출력). 패키징된 앱에서는 동작하지 않습니다.

VS Code 터미널에서 `ELECTRON_RUN_AS_NODE`가 설정돼 있으면 앱이 실행되지 않으니 해제하고 실행하세요. 인증 동작 기준은 [계정 인증](docs/features/auth.md)을 따릅니다.

검사와 빌드:

```bash
pnpm typecheck
pnpm build
```

## 구조

- `src/main/application`: 앱 생명주기·창(`application-manager`)과 그 조립 부품 — 트레이, 단축키, 앱 상태 연결(`state-sync`), 개발용 셀프테스트 연결
- `src/main/<기능>`: 기능별 폴더(auth, sensors, speech, conversation, tools, gesture, overlay, platform …). 각 폴더에 포트(인터페이스)와 구현이 함께 있음
- `src/main/interaction`: Main 상태·화면·명령 처리
- `src/main/ipc`: 소유 창과 입력을 검증하는 IPC 핸들러
- `src/preload`: UI·미디어·오버레이 Renderer에 각각 노출할 제한된 API
- `src/renderer/ui`: 사용자 화면(로그인 카드, 로그인 후 왼쪽 메뉴의 대화·제스처·설정 탭)
- `src/renderer/media`: 센서 입력(PCM·영상 프레임·손 인식 Worker)과 서버 TTS 오디오 재생용 별도 Renderer 진입점
- `src/renderer/overlay`: 상태 오버레이 화면
- `src/inference`: 로컬 VAD 프로세스 어댑터(호출어 자리 포함)
- `src/shared/contracts`: 앱·인증·UI·센서·제스처·도구·음성·오버레이 데이터와 검증 스키마
- `src/shared/ipc`: 각 Renderer의 제한된 공개 API 계약
- `src/shared/ports`: 여러 계층이 함께 쓰는 포트(오디오 재생, 카메라 프레임)
- `docs`: 기능 명세, 아키텍처, 검증 계획

기능 구현 기준은 [문서 목차](docs/README.md)를 참고하세요. 클라이언트에는 STT·TTS 모델을 넣지 않으며 로컬 KWS·VAD 모델과 네이티브 실행 파일의 패키징 방식은 기술 검증 후 확정합니다.

현재 인증 화면은 [Frosted Pearl 디자인 시스템](docs/design/design-system.md)을 따릅니다. 시각 토큰은 `src/renderer/ui/tokens.css`에서 공유하고 Pretendard·Inter 글꼴과 Lucide 아이콘은 앱에 포함합니다.

기본 실행은 밝은 불투명 네이티브 창과 앱 내부의 CSS 반투명 패널을 사용합니다. Vibrancy·Acrylic은 실제 창 외관에 문제가 확인되어 기본 비활성 상태이며, 개발 환경에서 `JARVIS_NATIVE_WINDOW_EFFECTS=1`을 지정한 경우에만 검증할 수 있습니다. 패키지 빌드에서는 이 실험 옵션을 적용하지 않습니다.

모듈 간 코드 계약과 대역 주입 방법은 [클라이언트 공통 인터페이스](docs/architecture/client-interfaces.md)를 따릅니다. UI의 현재 Preload API는 platform·dispatch·getSnapshot·subscribe입니다. 전체 UiApi의 auth 영역과 미디어 제어는 실제 핸들러를 구현한 뒤 공개합니다.
