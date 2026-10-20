# 앱과 OS 제어

요구사항 ID: APP-01~05.

## 앱과 OS 제어

| ID | 기능 | 동작 기준과 완료 조건 | 범위 |
| --- | --- | --- | --- |
| APP-01 | 앱 식별·상태 | OS에서 확인 가능한 앱 목록·실행 상태를 조회하고 안정적인 앱 ID로 관리. 불명확한 상태는 미확인으로 표시 | MVP |
| APP-02 | 앱 실행 | 미실행 앱 실행. 단순 실행 명령 전달과 실제 프로세스·창 확인 결과를 구분 | MVP |
| APP-03 | 앱 전환 | 실행 중인 대상 앱의 창 활성화 시도. 차단·권한 부족·창 없음 등을 결과에 반영 | MVP |
| APP-04 | 호출 전 작업 복귀 | 호출 직전의 앱·창 식별자를 보관하고 복귀 요청 시 유효성을 확인해 전환 | MVP |
| APP-05 | URL 열기 | 검증한 http·https URL을 기본 브라우저로 전달. 브라우저 전달 완료와 페이지 로딩 성공을 구분 | MVP |

서버가 보낸 임의 셸 명령이나 실행 파일 경로를 그대로 실행하지 않는다. 서버는 앱 ID와 등록된 도구 인자를 전달하고, 실제 실행 대상은 클라이언트의 앱 목록과 OS 어댑터에서 해석한다.

## 구현 현황

F-014([#14](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/14))에서 도구 계층과 macOS 어댑터를 구현했다. 계약과 포트는 [클라이언트 인터페이스](../architecture/client-interfaces.md#앱-도구와-실행-보고)에 둔다.

| 위치 | 책임 |
| --- | --- |
| `src/main/tools/tool-executor.ts` | 요청 검증, 인증·가용 상태 재확인, 실행 ID 중복 방지, 부작용 도구의 순차 실행, 취소·만료 보고 |
| `src/main/tools/capability-registry.ts` | 도구별 가용 상태와 리비전. 앱 도구는 macOS에서만 `available`, 그 밖에는 `unsupported` |
| `src/main/tools/restore-target.ts` | 호출 직전 전면 앱 기록(APP-04). 로그아웃·계정 전환 시 비움 |
| `src/main/platform/macos-app-control.ts` | macOS 앱 목록·실행·전환·전면 앱 조회·URL 전달 |
| `src/main/platform/command-runner.ts` | 고정 실행 파일과 인자 배열로만 OS 명령을 실행(셸 없음) |
| `src/main/platform/unsupported-app-control.ts` | 앱 어댑터가 없는 OS. 앱 도구는 `unsupported`, URL 전달만 동작 |

macOS 동작 기준은 다음과 같다.

- 앱 ID는 번들 ID다. 앱 목록은 `/Applications`·`/System/Applications`·사용자 `Applications`의 번들과 실행 중인 일반 앱을 합쳐 만들며, 자동화(Apple Events) 권한이 필요 없는 Foundation·AppKit 조회만 쓴다. 실행·전환 대상은 이 목록에 있는 ID만 허용하고 `open -b <번들 ID>`로 전달한다. ID 형식이 맞지 않거나 목록에 없으면 명령을 실행하지 않는다.
- 실행: 이미 실행 중이면 다시 열지 않고 `confirmed`. 아니면 `open` 후 프로세스가 나타나는지 5초까지 확인해 `confirmed`, 못 보면 `dispatched`.
- 전환: 실행 중인 앱만 대상이다(실행 중이 아니면 `not_found`이며 앱을 새로 시작하지 않는다). 전면 앱이 바뀌었는지 확인해 `confirmed`, 아니면 `dispatched`.
- 복귀: 기록한 앱을 전환한다. 창 단위 복귀는 접근성 권한이 필요해 macOS에서는 앱 단위까지만 지원한다.
- URL 열기: http·https만 허용하고 Electron `shell.openExternal`로 기본 브라우저에 전달한다. 결과는 `dispatched`다.
- 최근 작업 전환은 입력 어댑터와 함께 구현하며 지금은 `unsupported`다. Windows 앱 어댑터도 후속 구현이다.
- 개발용: 패키징되지 않은 앱에서 `JARVIS_TOOL_SELFTEST='[도구 요청 JSON 배열]'`을 주면 로그인 직후 순서대로 실행하고 `TOOL_SELFTEST` 줄로 보고를 출력한다.

