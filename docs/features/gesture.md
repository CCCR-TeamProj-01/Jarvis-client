# 제스처 제어

요구사항 ID: GEST-01~08.

손 관절·좌표·프레임 시각·세대와 OS 입력 포트는 [공통 인터페이스](../architecture/client-interfaces.md#손-관측제스처입력)를 따른다.

## 제스처 제어

| ID | 기능 | 동작 기준과 완료 조건 | 범위 |
| --- | --- | --- | --- |
| GEST-01 | 모드 시작·종료 | 음성·설정·단축키 등 명시적 요청으로 시작. 로컬 단축키·트레이에서 즉시 종료 가능 | MVP |
| GEST-02 | 커서 이동 | 포인팅 자세(검지만 폄)일 때 검지 뿌리 관절 좌표를 보정해 실제 OS 커서로 변환. 활성 손과 활성 화면 기준을 고정 | MVP |
| GEST-03 | Pinch 클릭 | 포인팅 자세에서 Pinch 진입 시 한 번 클릭하고 손을 풀기 전에는 추가 클릭하지 않음. 진입·해제 임계값을 구분 | MVP |
| GEST-04 | 최근 작업 전환 | 지정 제스처 1회에 작업 전환 1회. 유지 중 반복 전환 방지. Windows 창·macOS 앱 기준 차이 명시 | MVP |
| GEST-05 | 추적 손실·복구 | 손실 시 입력 중단과 자비스가 유지한 누름 상태 해제. 복구 시 이전 동작 재생 없이 중립 상태에서 재개 | MVP |
| GEST-06 | 입력 안정화 | 손떨림 보정, 이동 임계값, 클릭 후 재활성 조건 적용. 오래된 프레임은 폐기 | MVP |
| GEST-07 | 연결 독립 동작 | 서버 연결이 끊겨도 활성 로컬 제어와 중지 경로가 동작. 서버 연결 복구가 제어를 자동 재시작하지 않음 | MVP |
| GEST-08 | 로컬 진단 | 해당 기기에서 손 관절·추적·판정 결과를 표시. 진단 영상의 서버 상시 전송은 하지 않음 | 확장 |

커서 제어는 카메라 영상 속 손 좌표를 화면 좌표로 매핑하는 방식이다. 사용자가 실제 모니터의 특정 지점을 가리켰다는 절대 위치를 자동으로 아는 기능과는 구분한다. 실제 지점 포인팅을 목표로 하면 별도 보정·센서 검증이 필요하다.

## 제스처 커서 제어

카메라 → 최신 프레임 → 손 추적 Worker → 좌표 보정·Pinch 상태 판정 → 로컬 입력 어댑터 → OS 순서로 처리한다. 제어 모드 종료·권한 철회·추적 손실 시 입력 생성 중단과 대기 입력 폐기를 우선한다. 별도 입력 프로세스를 사용할 경우 heartbeat 중단 시 입력을 정지하고 자비스가 유지한 누름 상태를 해제하도록 한다.

## 구현 현황

F-018([#21](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/21))에서 카메라 프레임에서 손 관측까지, F-019([#23](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/23))에서 관측을 커서 이동·클릭으로 바꾸는 제어를 구현했다. 최근 작업 전환(GEST-04)은 아직 구현하지 않았다. 관측 계약은 [클라이언트 인터페이스](../architecture/client-interfaces.md#손-관측제스처입력)를 따른다.

| 위치 | 책임 |
| --- | --- |
| `src/renderer/media/hand-tracking/video-frame-source.ts` | 열린 카메라 스트림을 숨은 `<video>`로 재생해 일정 간격으로 프레임을 비트맵으로 복사. 이전 복사가 끝나지 않았거나 화면이 바뀌지 않았으면 건너뜀 |
| `src/renderer/media/hand-tracking/hand-tracking-pipeline.ts` | 분석 중에는 가장 최신 프레임 하나만 대기시키고 이전 대기 프레임은 닫음. 세대·sequence 부여, 연속 5회 실패하면 `engine_error`로 종료 |
| `src/renderer/media/hand-tracking/tracker-client.ts` | Worker에 비트맵을 넘기고(소유권 이전) 결과를 `HandTrackingFrame`으로 반환. Worker 종료·오류 시 대기 중인 요청을 모두 마무리 |
| `src/renderer/media/hand-tracking/hand-landmarker.worker.ts` | MediaPipe `HandLandmarker`(VIDEO 모드, CPU WASM, 두 손). 모듈 Worker가 읽을 수 있는 module 빌드를 사용하고 모델은 Main이 준 바이트로 로드 |
| `src/renderer/media/hand-tracking/landmarks.ts` | 엔진 결과를 관측으로 변환. 엔진이 거울상 영상을 가정하므로 좌우를 뒤집고, 범위를 벗어났거나 관절이 모자란 손은 버림 |
| `src/main/gesture/hand-tracking.ts` | `HandTrackingService`. `gesture_control` 카메라 사용권을 얻어 추적을 시작·중지하고 이벤트를 전달. 사용권 철회·렌더러 오류·중지 시 카메라를 반납하고 필요하면 `tracking.lost`로 알림 |

- 영상은 Media Renderer 안에서만 처리한다. Main에는 관절 좌표만 전달하며 서버로는 보내지 않는다.
- Main이 모델 파일(`hand_landmarker.task`)을 읽어 시작 명령에 바이트로 담는다. 페이지가 파일 시스템 URL을 직접 읽지 않으므로 개발 서버(http)와 패키지(file) 모두 같은 방식으로 동작한다. 모델은 `pnpm models:fetch`가 내려받고 해시를 검증하며, 없으면 시작이 `unavailable`로 실패하고 명령을 안내한다.
- 프레임 속도 기본값은 15 fps이며 `maxFps`로 조정한다. 인식이 느리면 프레임을 버려 지연이 쌓이지 않게 한다.
- 손이 없을 때는 빈 `hands`의 프레임을 계속 보낸다(`no_hand` 손실 판단은 GestureController 몫). `permission_revoked`·`engine_error` 손실 이벤트는 추적의 종료를 뜻하며 Main은 카메라를 반납한다. 이전 세대와 되돌아간 sequence의 프레임은 버린다.
- 프레임 시각 `capturedAtMs`는 Media Renderer의 `performance.now()` 시계다. 오래된 프레임 판정(GEST-06)은 후속 이슈에서 시계 차이를 맞춰 적용한다.
- 개발용(패키징되지 않은 앱 한정): `JARVIS_FAKE_MEDIA=1`에 `JARVIS_FAKE_VIDEO_FILE=<y4m 또는 mjpeg 경로>`를 더하면 영상 파일이 카메라가 되고, `JARVIS_HAND_SELFTEST=<초>`는 로그인 후 그 시간 동안(`0`이면 로그아웃·종료까지 계속) 추적해 `HAND_SELFTEST` 줄(시작 시간, 프레임 요약, 프레임 수·손이 보인 프레임 수)로 출력한다.

### 커서 제어 (F-019)

| 위치 | 책임 |
| --- | --- |
| `src/main/gesture/gesture-controller.ts` | `GestureControlPort` 구현. 세대 소유, 시작 조건 확인, 프레임 판정, 입력 큐, 손실·복구, 종료 순서 |
| `src/main/gesture/cursor-mapper.ts`, `one-euro-filter.ts` | 검지 끝을 화면 좌표로 변환(좌우 거울 보정)하고 One Euro 필터로 손떨림 보정 |
| `src/main/gesture/pinch-detector.ts`, `active-hand.ts`, `frame-clock.ts` | Pinch 히스테리시스, 활성 손 선택·고정, 렌더러 시계와 Main 시계의 오프셋 보정으로 프레임 나이 계산 |
| `src/main/gesture/tuning.ts` | 감각을 정하는 값(영역 여백, 평활, 데드존, Pinch 임계값, 기한). 실기기에서 조정할 한곳 |
| `src/main/platform/pointer-input.ts` | `PointerInputPort` 구현. 세대 취소·기한·순서를 확인하고 OS 포인터 드라이버를 호출 |
| `src/main/platform/libnut-driver.ts` | macOS·Windows 드라이버(`@nut-tree-fork/libnut-darwin`·`-win32`, 필요할 때 로드), Electron 화면 목록, 개발용 가짜 드라이버 |
| `src/main/gesture/create-gesture.ts` | 실제 부품 조립. macOS 손쉬운 사용 권한 확인 |

동작 기준은 다음과 같다.

- 커서는 검지 끝이 아니라 검지 뿌리 관절(index MCP)을 따른다. 엄지가 다가오면 검지 끝이 같이 움직여 클릭 순간 커서가 목표에서 벗어나기 때문이다.
- 포인팅 자세(검지를 펴고 중지·약지·새끼를 접음)일 때만 커서가 움직이고 클릭이 나간다. 각 손가락이 손목에서 뻗은 거리를 뿌리 관절까지의 거리로 나눈 값(펴면 약 1.5 이상, 접으면 1 안팎)으로 판정하며, 시작은 엄격한 기준·유지는 느슨한 기준을 쓰고 일시적으로 자세가 풀려도 200 ms는 유지한다. Pinch로 검지가 구부러지는 동안에는 자세를 유지한 것으로 본다. 손을 펴거나 주먹을 쥐면 커서는 그 자리에 남고, 다시 가리키면 손의 현재 위치로 이동한다(절대 좌표 대응이므로 상대 이동처럼 손을 들어 옮기는 동작은 아니다). 포인팅 자세가 아닐 때의 Pinch는 클릭이 아니며, 그 상태에서 자세를 바꿔도 손을 한 번 펴야 다음 클릭이 가능하다.
- 카메라 영상 안에서 화면 전체에 대응하는 영역(가장자리 여백 제외)을 활성 화면의 논리 좌표에 대응시킨다. 카메라 영상은 반전하지 않으므로 손이 사용자의 오른쪽으로 가면 커서도 오른쪽으로 간다. 클릭은 시작 시점에 고정한 활성 화면에서만 일어난다(`primary`는 첫 화면).
- 활성 손은 기본 `auto_lock`(가장 신뢰도 높은 손을 세션 동안 고정)이다. 고정한 손이 사라져도 다른 손으로 바로 바꾸지 않고, 손실이 `lostAfterMs` 이상 이어지면 고정을 풀어 다시 고른다.
- Pinch는 엄지·검지 끝 거리를 손 크기(손목–가운데 손가락 뿌리)로 나눈 값이 진입 임계값 아래로 내려가면 시작하고 해제 임계값을 넘어야 끝난다. 시작할 때 한 번만 클릭하고, 손가락이 모이는 중(Pinch 비율이 150 ms 안에 0.12 넘게 떨어짐)부터 Pinch를 유지하는 동안과 펴진 뒤 150 ms까지 커서를 멈춘다. 손가락이 모이는 것이 감지된 경우 클릭은 멈춰 있는 커서 위치로 가고, 감지 없이 갑자기 Pinch가 되면 직전(약 120 ms 전)의 커서 위치로 보낸다. 시작 시점(또는 손 복구 시점)에 이미 Pinch 상태이면 손을 한 번 펴야 클릭이 가능하다.
- 입력은 하나씩 순서대로 보내되 대기 중인 이동은 최신 하나로 합친다. 입력마다 증가하는 sequence와 기한을 붙이며, 포인터 쪽은 취소된 세대·지난 기한·뒤처진 sequence를 실행하지 않는다.
- 손이 사라지거나 `lostAfterMs` 동안 쓸 만한 프레임이 없으면 `lost`가 되어 입력을 멈추고 대기 입력을 버린다. 손이 돌아오면 필터와 Pinch 상태를 처음부터 시작하며 이전 동작을 재생하지 않는다. 기한(`maxFrameAgeMs`)을 넘긴 프레임은 버린다.
- `engine_error`·`permission_revoked` 손실, OS가 입력을 거부하는 경우, 시작 후 손쉬운 사용 권한이 철회된 경우(2초마다 재확인)에는 제어 모드를 끝내고 화면에 이유를 알린다. 세대를 먼저 무효화한 뒤 포인터 취소, 입력 해제, 추적·카메라 반납 순으로 정리한다.
- 시작은 로그인·인식 일시 중지 해제 상태에서만 가능하다. 로그아웃·계정 전환·일시 중지·앱 종료에서는 즉시 끝나고, 중지는 인증 없이 항상 동작한다.
- macOS는 손쉬운 사용 권한이 없으면 시작하지 않고 시스템 권한 요청을 띄운 뒤 설정 위치를 안내한다. 권한은 이 화면에서 허용한 뒤 다시 시작해야 적용된다. `lost`에서 `tracking`으로의 전환과 활성 손은 화면 상태에 표시한다. 일시 중지 상태를 뜻하는 `suspended`는 아직 쓰지 않는다.
- 시작·종료 진입점: 화면의 제스처 시작·중지 버튼, 트레이 메뉴의 제스처 시작·중지, 전역 단축키 `CommandOrControl+Shift+G`(켜기/끄기).
- 개발용(패키징되지 않은 앱 한정): `JARVIS_FAKE_POINTER=1`은 실제 포인터를 움직이지 않고 `POINTER_FAKE move x y`(약 250 ms에 한 줄)·`POINTER_FAKE click x y`를 출력한다. `JARVIS_HAND_SELFTEST`의 프레임 줄에는 손마다 `pinch`(엄지–검지 거리 비율)와 `reach`(검지·중지·약지·새끼의 뻗은 정도)가 포함되어 임계값을 조정하는 근거로 쓸 수 있다. 샘플 사진 기준으로 가리키는 손은 `reach` [1.79, 0.66, 0.63, 0.71], 편 손은 모두 1.5~1.9였다.

