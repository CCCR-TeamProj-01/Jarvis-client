# 클라이언트 공통 인터페이스

클라이언트 모듈 사이의 데이터·메서드·오류·자원 정리 규약이다. [이슈 #2](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/2)의 코드 계약을 정의하며 서버의 엔드포인트·인증·전송 프로토콜은 후속 어댑터에서 결정한다. 기능 범위는 [클라이언트 아키텍처](client.md)와 각 기능 명세를 따른다.

이슈 #2의 구현에 추가되는 인증 계약은 [계정 인증](../features/auth.md#클라이언트-계약과-구조)과 [이슈 #5](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/5)를 따른다. F-008에서 인증 데이터·공개 API·Main 포트 계약을 구현했으며, 실제 인증 기능과 Preload 연결은 후속 작업이다.

## 배치와 책임

| 위치 | 코드 계약 | 구현 작업 |
| --- | --- | --- |
| `src/shared/contracts/common.ts` | 식별자, 세션·버전, 결과·오류, 구독 해제 | 공통 |
| `src/shared/contracts/interaction.ts`, `src/shared/ipc/ui-api.ts` | 명령·화면용 상태·이벤트·UI 공개 API | F-003 |
| `src/shared/contracts/sensors.ts`, `src/main/sensors/ports.ts` | 장치·권한·사용권·센서 관리자 포트 | F-004 |
| `src/shared/contracts/gesture.ts`, `src/main/platform/ports.ts` | 손 관측 결과·화면 좌표·OS 입력 포트 | F-005 |
| `src/shared/contracts/tools.ts`, `src/main/tools/ports.ts` | 도구별 인자·가용 상태·실행 보고·앱 제어 포트 | F-006 |
| `src/shared/contracts/speech.ts`, `src/shared/ipc/media-api.ts` | 로컬 PCM·완료 발화·재생 이벤트·미디어 제어 | F-007 |
| `src/renderer/media/*/ports.ts`, `src/inference/ports.ts` | 캡처·재생·호출어·VAD 엔진의 실행 공간 내부 포트 | F-007 |
| `src/main/speech/session/ports.ts` | 로컬 음성 세션·인식 이벤트·완료 발화 구독 포트 | F-007 |
| `src/main/ports.ts` | Main 단조 시계, 로컬 취소·기한 옵션 | 공통 |
| `src/shared/contracts/application.ts` | 트레이·단축키 준비/등록/실패 상태 | F-009 |
| `src/shared/contracts/auth.ts`, `src/shared/ipc/auth-api.ts`, `src/main/auth/ports.ts` | 인증 데이터·전용 API·서버와 보호 저장소의 Main 포트 | F-008 |

데이터 스키마는 Zod로 정의하고 TypeScript 타입을 추론한다. 프로세스 경계에서 입력을 검증하며 알 수 없는 필드는 거부한다. Main 전용 포트는 Main에, 브라우저 실행 공간의 포트는 해당 미디어·인식 영역에 둔다. 공유 계약은 Electron·Node·플랫폼 구현을 import하지 않는다.

이슈 #2의 구현은 타입·스키마·포트와 경계 검증을 제공한다. F-009에서 앱 실행 기반·InteractionManager와 실제 UI IPC를 연결했다. 센서 관리자·인식 엔진·OS 실행기·인증 API 핸들러는 후속 작업이다. 미구현 공개 메서드는 `window`에 노출하지 않으며 현재 UI의 실제 타입은 `InteractionUiApi`, 미디어 API는 Bootstrap 타입이다.

## 공통 식별자·오류·시간

- `Generation`은 `sessionId`와 증가하는 `revision`으로 구성한다. 대화·제스처·센서는 독립적인 세대를 가진다. 종료·일시 중지·권한 철회 시 먼저 세대를 무효화하고 정리를 시작한다. 이전 세대의 이벤트는 적용하지 않는다.
- 활성 대화·음성·제스처 상태는 해당 세대를 포함한다. idle·off 스냅샷은 세대를 비운다. 처리 중인 요청은 requestId를 포함하고 idle 요청은 비운다.
- 프레임·PCM의 `sequence`는 해당 세대에서 증가한다. 같은 번호의 중복과 역순 도착은 폐기한다. 새로운 세대에서는 번호를 다시 시작할 수 있다.
- 예상 가능한 실패는 `Result<T>`의 오류 데이터로 반환한다. 오류 코드는 권한 거부, 장치 없음, 미지원, 잘못된 인자, 대상 없음, 취소, 만료, 충돌, 일시 불가, 내부 오류를 구분한다. Error 객체·스택·인증 정보는 IPC 결과로 넘기지 않는다.
- `Unsubscribe`는 동기 함수다. 재호출은 안전해야 하며 등록했던 리스너만 해제한다. 전체 리스너를 지우는 범용 API는 공개하지 않는다.
- Main의 기한은 주입한 단조 시계의 `deadlineMs`다. `AbortSignal`과 Clock은 프로세스 내부 포트에만 전달한다. IPC에는 명시적인 중지·취소 명령과 식별자를 보낸다.
- 카메라 `capturedAtMs`는 Media Renderer의 `performance.now()` 기준이며 Worker에는 그 값을 그대로 전달한다. 프레임 나이 검사는 동일한 Media Renderer 시계에서 수행한다. Main·다른 Renderer의 `performance.now()`와 직접 비교하지 않는다. Main은 세대·순서를 재검증하고 자신의 시계로 입력 대기 시간을 제한한다.
- PCM의 시간은 `startSample`과 샘플 수로 표현한다. 서버 시간·conversationId·프로토콜 버전은 로컬 캡처 데이터에 요구하지 않는다.

## 화면과 Main

UI 명령은 인증 화면 열기·앱 종료, 대화 시작·텍스트 입력·대화 종료, 제스처 시작·종료, 인식 일시 중지·재개, 설정 열기, 확인 응답으로 구성한다. 대화 호출과 제스처 제어 시작은 별도 명령이다. UI는 실행 출처나 권한을 주장할 수 없으며 Main이 발신 창과 현재 상태를 검증한다.

현재 `InteractionUiApi`는 platform과 다음 메서드를 공개한다. 전체 `UiApi`의 auth 영역은 실제 인증 핸들러를 구현한 뒤 공개한다.

- `dispatch(command)`: 명령 수락 결과를 반환한다. 수락은 앱 실행 성공이나 기능 시작 완료를 뜻하지 않는다.
- `getSnapshot()`: 대화·음성·제스처·센서·화면·일시 중지 상태를 조회한다. 상태 원본은 Main이다.
- `subscribe(listener)`: 상태 변경·결과·확인 요청·오류 이벤트를 구독하고 `Unsubscribe`를 반환한다.

`ClientSnapshot.application`은 단축키의 accelerator·pending/registered/unavailable과 트레이의 pending/ready/unavailable을 담는다. 실패에는 오류 데이터가 필수다. 초기 실패를 이벤트로만 보내지 않고 스냅샷에도 유지해 늦게 연결된 화면이 안내할 수 있게 한다. UI는 구독을 먼저 연결하고 초기 스냅샷을 읽으며 낮은 revision의 응답으로 최신 이벤트를 덮어쓰지 않는다.

screen은 창을 다시 열 때 표시할 논리 화면이다. 네이티브 창의 숨김·표시·최소화·포커스는 Main의 UiWindow가 관리하며, 미로그인 창을 트레이로 숨길 때도 논리 화면은 login 또는 signup으로 유지한다.

확인 응답은 confirmationId와 approve·reject·dismiss 중 하나로 표현한다. 닫기는 dismiss다. 유효 대상과 기한의 검사는 Main이 수행한다. 화면에 표시하는 만료 시각은 안내용이며 Main의 실행 기한을 대체하지 않는다.

IPC 채널은 UI 명령·상태 조회·이벤트와 미디어 명령·이벤트로 고정한다. Preload는 정해진 기능만 감싸고 Electron 이벤트 객체를 콜백에 넘기지 않는다. UI용과 미디어용 API는 분리한다.

F-009의 UI IPC는 현재 소유 UI WebContents·최상위 프레임의 동일성과 허용된 entry URL이 모두 일치해야 수락한다. 다른 창·하위 프레임·다른 문서의 요청을 거부하며 인자 수·명령·응답·이벤트를 스키마로 검증한다. 예외의 스택·원문은 UI에 전달하지 않는다. 종료 시 소유 핸들러와 구독만 제거한다.

sandbox Preload는 각 진입점을 독립 번들로 만들고 Zod를 포함한다. `electron-vite`의 preload build에 `externalizeDeps: false`, `isolatedEntries: true`를 적용해 sandbox에서 npm 패키지나 공통 청크를 require하지 않게 한다. 설정 기준은 설치된 electron-vite의 타입 선언과 실제 Electron 실행 검증이다.

### 인증 계약 확장

`shared/contracts/auth.ts`와 `shared/ipc/auth-api.ts`, `UiApi.auth`, 고정된 `AUTH_CHANNELS`를 정의했다. 실제 핸들러는 후속 구현에서 Main의 발신 창·입력·현재 인증 세대 검증과 함께 연결한다. 정확한 요청·결과·상태·Main 포트의 배치는 [인증 원본](../features/auth.md#클라이언트-계약과-구조)에 둔다. 인증 입력을 일반 실행 명령 기록에 섞거나 Media API에 노출하지 않는다. `AuthSnapshot`에는 공개 사용자·인증 상태·인증 세대만 포함한다.

`ClientSnapshot.auth`와 screen의 login·signup을 추가했으며 미인증 상태의 일반 화면 스냅샷을 거부한다. `auth.open`은 인증 화면 전환 요청이다. 기존 `UiCommand`·도구 호출·센서 시작은 실제 구현에서 Main이 현재 인증을 검사한 뒤 실행하며, UI 상태를 신뢰해 인증을 생략하지 않는다. 중지·정리·종료는 인증 상태와 무관하게 허용한다.

인증 세대는 대화·제스처 세대와 별도로 관리한다. 로그아웃·계정 전환·세션 무효화 시 인증 세대를 먼저 무효화하고 관련 로컬 세대·연결을 정리한다. 늦은 로그인·복구 결과와 이전 사용자의 서버 메시지를 폐기한다. 인증 서버·보호 저장소 포트는 Main 내부에 배치했다. `tests/typecheck/ports.ts`에 독립적인 포트 구현 예제를 추가했으며, 실제 상태 전이와 서버 호출은 후속 구현에서 명시적인 개발용 대역으로 검증한다.

## 센서 사용권

센서 종류는 camera·microphone이고 소비 기능은 voice_wake·speech_session·gesture_call·gesture_control·diagnostics다. 음성 기능은 microphone, 제스처 기능은 camera를 요청한다. diagnostics는 필요한 센서 종류를 명시한다.

`SensorPort.acquire`는 장치 선택과 권한 확인 후 leaseId·소유 기능·실제 deviceId를 반환한다. `release(leaseId)`는 released 또는 already_released를 반환한다. 한 기능의 반납은 다른 사용권을 취소하지 않으며 마지막 사용권이 반납되면 장치를 해제한다. 장치 오류·권한 철회는 해당 사용권의 revoked 이벤트로 전달한다. 실제 자원 관리는 후속 SensorManager 구현의 책임이다.

장치·권한·사용 상태는 구분한다. MediaStream·MediaStreamTrack·장치 핸들은 캡처 실행 공간에 유지하며 공유 데이터에는 넣지 않는다.

센서 사용 상태는 idle·starting·active·stopping·unavailable·error다. active는 권한·장치·사용권을 모두 필요로 하고, 마지막 사용권 반납 후 비동기 장치 정리 중에는 stopping으로 표현한다.

## 손 관측·제스처·입력

Worker는 손 관측 결과를 만들고 Main의 GestureController가 활성 손 선택·좌표 보정·Pinch·전환·호출 판정을 한다. 활성 손은 left·right 중 설정값을 고정하며 자동 선택을 사용하면 세대 동안 선택한 handId를 유지한다. 해당 손을 잃으면 다른 손으로 즉시 전환하지 않고 중립 상태에서 다시 활성화한다.

- 입력 영상은 반전하지 않은 원본 카메라 좌표다. 원점은 왼쪽 위이며 x는 오른쪽, y는 아래 방향으로 0~1 범위를 사용한다. 미러링은 미리보기 표시 단계에서 수행한다. 엔진 어댑터는 범위를 벗어난 손을 유효 관측으로 보내지 않는다.
- 각 손은 세대 안에서 유효한 handId·물리적 handedness·신뢰도와 21개 관절을 가진다. 관절 순서는 wrist, thumb 4개, index 4개, middle 4개, ring 4개, pinky 4개다. z는 엔진의 손목 상대 깊이 값이며 화면 깊이나 실제 거리로 해석하지 않는다.
- 프레임은 세대·sequence·capturedAtMs·hands를 담는다. 손이 없으면 빈 배열이다. 추적 손실 이벤트는 no_hand·stale·engine_error·permission_revoked 이유를 제공한다.
- 화면 좌표는 displayId와 전역 논리 좌표 x·y다. 왼쪽 또는 위쪽 모니터의 음수 좌표를 허용한다. GestureController가 화면 영역에 맞춰 변환하고 플랫폼 어댑터가 실제 OS 좌표로 바꾼다.

`PointerInputPort`는 이동·단일 클릭·자비스가 유지한 누름 해제·세대 취소를 제공한다. 최근 작업 전환은 `AppControlPort`가 담당한다. 입력 명령은 Main에서 부여한 세대·기한을 포함한다. 이동은 최신 대기 좌표를 우선하며 클릭·전환은 한 번의 동작마다 한 번만 실행한다. 세대 취소는 대기 입력을 버리고 자비스의 누름 상태를 해제한다. 다른 프로그램이 만든 누름 상태를 임의 해제하지 않는다.

## 앱 도구와 실행 보고

도구는 apps.list·apps.launch·apps.activate·apps.restore·browser.open을 식별자로 사용하고 인자를 도구별로 검증한다. 앱 ID는 로컬 앱 목록에서 해석하며 임의 셸·실행 파일 경로는 받지 않는다. URL은 http·https만 허용한다.

`AppControlPort`는 앱 조회·실행·활성화·호출 전 창 조회·복귀·최근 작업 전환·URL 전달을 정의한다. 복귀 참조는 appId와 선택적인 windowId이며 실행 시 유효성을 재확인한다. 플랫폼별 포커스 제약과 창·앱 전환 차이는 결과에 반영한다.

`ToolExecutionReport`는 requestId·executionId·도구와 실제 outcome, cancelRequested·expired를 분리한다. outcome은 not_started·observed·failed·unknown이다. observed 내부에서도 실제 상태 확인과 단순 전달을 구분한다. URL의 브라우저 전달은 페이지 로딩 성공으로 기록하지 않는다.

취소·만료 전에 시작하지 않은 작업은 not_started로 보고한다. 이미 실행한 동작은 결과를 보존한 채 취소 요청 여부를 별도로 기록한다. 결과 불명 시 unknown을 반환하며 동일 executionId로 부작용을 자동 재실행하지 않는다. 중복 방지와 실행 직전 재검증은 후속 ToolExecutor 구현이 담당한다.

## 음성·미디어

로컬 오디오는 mono PCM signed 16-bit little endian과 sampleRateHz로 표현한다. 캡처 어댑터가 추론 엔진의 지원 샘플레이트에 맞춰 리샘플링한다. sampleRateHz를 서버 전송 형식으로 확정하는 것은 후속 통신 어댑터의 책임이다.

- `PcmChunk`는 세대·sequence·startSample·format·audio를 담는다. 바이트 수는 16-bit 샘플에 맞아야 한다.
- 활성 발화의 PCM은 연속된 샘플·sequence·형식을 유지한다. 대기열 초과·누락이 생기면 해당 수집을 종료하며 떨어진 구간을 이어 붙이지 않는다. 카메라의 최신 프레임 우선 정책을 PCM에 그대로 적용하지 않는다.
- `CompletedUtterance`는 utteranceId·세대·startSample·sampleCount·format·audio를 담는다. 샘플 수와 실제 바이트 길이가 일치하고 0보다 커야 한다. 발화 길이는 sampleCount / sampleRateHz로 계산한다.
- `AudioCapturePort`는 유효한 마이크 leaseId로 시작하고, 중지·버퍼 폐기·확정 구간 추출·PCM 구독을 제공한다. 호출어·VAD 어댑터는 세대를 유지하며 샘플 경계를 반환한다.
- `AudioPlaybackPort`는 playbackId·세대·MIME·오디오를 받아 재생하고 started·ended·stopped·failed 이벤트를 낸다. 시작 요청 수락과 실제 재생 완료는 구분한다.
- 미디어 제어 명령은 카메라·오디오 시작/중지, 버퍼 폐기, 발화 추출, 오디오 재생/중지다. 장치 자격은 SensorManager의 leaseId로 확인한다. Media API가 인증 자격 증명이나 서버 주소를 받지 않는다.

UI 제어·상태 데이터와 영상·PCM 데이터의 전달 경로를 구분한다. ImageBitmap·VideoFrame은 Media Renderer와 Worker 사이에 유지하고 Main에는 관측 결과와 필요한 발화 바이트만 전달한다. 고빈도 전송의 실제 MessagePort·Worker 배치는 미디어 구현 시 측정해 결정한다.

기존 `src/shared/speech-protocol/`의 사용되지 않는 서버 메타데이터·버전 초안은 로컬 `contracts/speech.ts`로 교체했다. 이후 서버 어댑터가 로컬 발화에 인증·원격 요청 식별자를 덧붙인다. 서버 API를 이번 작업에서 고정하지 않는다.

## 취소·정리와 대역 사용

중지는 먼저 현재 세대를 무효화하고 로컬 입력 대기열을 비운 뒤 인식 중지·오디오 폐기·재생 중단·센서 사용권 반납을 수행한다. 서버 취소 응답을 기다리지 않는다. 대화 종료는 제스처를 종료하지 않으며, 전체 일시 중지는 각 기능의 독립 정리 경로를 호출한다.

포트는 생성자 또는 팩토리 인자로 주입한다. 개발용 SensorPort는 고정된 장치·사용권을, PointerInputPort는 요청 기록을, AudioPlaybackPort는 시험용 재생 이벤트를 제공할 수 있다. 테스트에서 주입한 시계와 대역으로 오래된 세대·순서·시간 초과·정리 동작을 재현한다. 대역의 존재가 실제 OS·센서·서버 기능 완료를 의미하지 않는다.

`tests/typecheck/ports.ts`는 센서·입력·재생 포트를 `satisfies`로 구현하는 컴파일 예제다. 장치가 없는 대역도 정상적인 오류 결과를 제공할 수 있다. 이 예제는 센서 관리자나 제스처 제어기의 런타임 구현을 대체하지 않는다.

핵심 검증은 잘못된 IPC 명령·센서 조합·좌표·오디오 길이·URL 거부, 이전 세대·중복 프레임 폐기, 취소와 실제 실행 결과 분리, 로컬 데이터의 structuredClone 전달, 포트의 독립 구현 가능성이다. 타입 선언 자체를 확인하는 상수 테스트보다 실제 경계 조건을 검증한다.

## 참고

- [Electron IPC](https://www.electronjs.org/docs/latest/api/ipc-renderer): 복제 가능한 데이터와 DOM 객체의 전송 경계
- [Electron contextBridge](https://www.electronjs.org/docs/latest/api/context-bridge): 제한된 Preload API와 콜백 경계
- [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker): 손 관절 출력
- [Zod](https://zod.dev/basics): 런타임 스키마와 타입 추론
