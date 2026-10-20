# 제스처 제어

요구사항 ID: GEST-01~08.

손 관절·좌표·프레임 시각·세대와 OS 입력 포트는 [공통 인터페이스](../architecture/client-interfaces.md#손-관측제스처입력)를 따른다.

## 제스처 제어

| ID | 기능 | 동작 기준과 완료 조건 | 범위 |
| --- | --- | --- | --- |
| GEST-01 | 모드 시작·종료 | 음성·설정·단축키 등 명시적 요청으로 시작. 로컬 단축키·트레이에서 즉시 종료 가능 | MVP |
| GEST-02 | 커서 이동 | 검지 끝 좌표를 보정해 실제 OS 커서로 변환. 활성 손과 활성 화면 기준을 고정 | MVP |
| GEST-03 | Pinch 클릭 | Pinch 진입 시 한 번 클릭하고 손을 풀기 전에는 추가 클릭하지 않음. 진입·해제 임계값을 구분 | MVP |
| GEST-04 | 최근 작업 전환 | 지정 제스처 1회에 작업 전환 1회. 유지 중 반복 전환 방지. Windows 창·macOS 앱 기준 차이 명시 | MVP |
| GEST-05 | 추적 손실·복구 | 손실 시 입력 중단과 자비스가 유지한 누름 상태 해제. 복구 시 이전 동작 재생 없이 중립 상태에서 재개 | MVP |
| GEST-06 | 입력 안정화 | 손떨림 보정, 이동 임계값, 클릭 후 재활성 조건 적용. 오래된 프레임은 폐기 | MVP |
| GEST-07 | 연결 독립 동작 | 서버 연결이 끊겨도 활성 로컬 제어와 중지 경로가 동작. 서버 연결 복구가 제어를 자동 재시작하지 않음 | MVP |
| GEST-08 | 로컬 진단 | 해당 기기에서 손 관절·추적·판정 결과를 표시. 진단 영상의 서버 상시 전송은 하지 않음 | 확장 |

커서 제어는 카메라 영상 속 손 좌표를 화면 좌표로 매핑하는 방식이다. 사용자가 실제 모니터의 특정 지점을 가리켰다는 절대 위치를 자동으로 아는 기능과는 구분한다. 실제 지점 포인팅을 목표로 하면 별도 보정·센서 검증이 필요하다.

## 제스처 커서 제어

카메라 → 최신 프레임 → 손 추적 Worker → 좌표 보정·Pinch 상태 판정 → 로컬 입력 어댑터 → OS 순서로 처리한다. 제어 모드 종료·권한 철회·추적 손실 시 입력 생성 중단과 대기 입력 폐기를 우선한다. 별도 입력 프로세스를 사용할 경우 heartbeat 중단 시 입력을 정지하고 자비스가 유지한 누름 상태를 해제하도록 한다.

## 구현 현황

F-018([#21](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/21))에서 카메라 프레임에서 손 관측까지를 구현했다. 좌표 보정·Pinch 판정·OS 입력·작업 전환(GEST-02~04, 06)은 후속 이슈에서 이 관측 위에 올린다. 관측 계약은 [클라이언트 인터페이스](../architecture/client-interfaces.md#손-관측제스처입력)를 따른다.

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
- 개발용(패키징되지 않은 앱 한정): `JARVIS_FAKE_MEDIA=1`에 `JARVIS_FAKE_VIDEO_FILE=<y4m 또는 mjpeg 경로>`를 더하면 영상 파일이 카메라가 되고, `JARVIS_HAND_SELFTEST=<초>`는 로그인 후 그 시간 동안 추적해 `HAND_SELFTEST` 줄(시작 시간, 프레임 요약, 프레임 수·손이 보인 프레임 수)로 출력한다.
