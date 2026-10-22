# 앱과 OS 제어

요구사항 ID: APP-01~07.

## 앱과 OS 제어

| ID | 기능 | 동작 기준과 완료 조건 | 범위 |
| --- | --- | --- | --- |
| APP-01 | 앱 식별·상태 | OS에서 확인 가능한 앱 목록·실행 상태를 조회하고 안정적인 앱 ID로 관리. 불명확한 상태는 미확인으로 표시 | MVP |
| APP-02 | 앱 실행 | 미실행 앱 실행. 단순 실행 명령 전달과 실제 프로세스·창 확인 결과를 구분 | MVP |
| APP-03 | 앱 전환 | 실행 중인 대상 앱의 창 활성화 시도. 차단·권한 부족·창 없음 등을 결과에 반영 | MVP |
| APP-04 | 호출 전 작업 복귀 | 호출 직전의 앱·창 식별자를 보관하고 복귀 요청 시 유효성을 확인해 전환 | MVP |
| APP-05 | URL 열기 | 검증한 http·https URL을 기본 브라우저로 전달. 브라우저 전달 완료와 페이지 로딩 성공을 구분 | MVP |
| APP-06 | 폴더 열기 | 서버가 보낸 폴더 별칭(`home`·`desktop`·`documents`·`downloads`·`pictures`·`music`·`videos`)만 받아 Main이 이 기기의 표준 폴더로 해석하고 기본 파일 관리자에 전달. 서버 도구가 현재 보내는 별칭은 `downloads`·`documents`·`desktop`·`pictures` 4개이고 나머지는 서버가 확장할 때를 위해 받는다. 임의 경로·상대 경로·알 수 없는 별칭은 실행 전 거절. 파일 관리자 전달과 창 열림 확인을 구분하고 실제 경로는 보고·로그·서버 전송에 담지 않음 | MVP |
| APP-07 | 시스템 볼륨·음소거 | 컴퓨터의 출력 볼륨을 절대값(0~100 정수) 또는 상대 변화량(-100~100 정수)으로 바꾸고 음소거를 켜고 끔. 범위 밖·소수·알 수 없는 모드·추가 필드는 실행 전 거절. 변경 후 OS에서 실제 상태를 다시 읽어 일치하면 확인, 읽지 못하면 전달만, 불일치하면 미확인으로 구분해 보고. 자비스 응답 소리 설정·마이크 입력과 무관 | MVP |

서버가 보낸 임의 셸 명령이나 실행 파일 경로를 그대로 실행하지 않는다. 서버는 앱 ID와 등록된 도구 인자를 전달하고, 실제 실행 대상은 클라이언트의 앱 목록과 OS 어댑터에서 해석한다.

## 서버 도구와 앱 식별

서버는 도구 정의와 사용자 요청의 실행 계획을 관리하고, Main은 이 기기에서 실제 지원하는 도구·버전·권한·가용 상태를 보고한다. 서버 목록에 있다는 이유로 미지원 도구를 실행하지 않으며 실행 직전에 인증·현재 가용 상태를 재검증한다.

서버의 `requested_app_code`(예: chrome)와 로컬의 OS 앱 ID(예: macOS 번들 ID)는 다른 식별자다. Main의 서버 어댑터와 앱 목록을 통해 검증된 로컬 대상으로 연결한다. 매핑이 없거나 후보가 여러 개면 임의 실행하지 않고 대상 없음·추가 선택 필요를 구분한다. 미설치·미지원·권한 부족·실행 오류는 [실행 보고 계약](../architecture/server-integration.md#명령-계획과-실행-결과)에 따라 보고한다. 앱 코드 14개는 서버가 고정했고([서버 연동](../architecture/server-integration.md#명령-계획과-실행-결과)) 코드 → OS 앱 ID 매핑표는 클라이언트가 내장한다. macOS 매핑과 기기에서 확인한 범위는 [명령 번역기](../architecture/server-integration.md#구현-현황-명령-번역기와-결과-매핑)를 따른다.

APP-01~07의 실제 관측 기준과 URL 검증은 유지한다. 서버 DB의 명령 ID·결과 행 ID를 OS 앱 식별자로 사용하지 않는다. 원래 요청과 추천 승인으로 생성된 명령 모두 같은 실행 검증을 거친다.

## 구현 현황

F-014([#14](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/14))에서 도구 계층과 macOS 어댑터를 구현했다. 계약과 포트는 [클라이언트 인터페이스](../architecture/client-interfaces.md#앱-도구와-실행-보고)에 둔다.

| 위치 | 책임 |
| --- | --- |
| `src/main/tools/tool-executor.ts` | 요청 검증, 인증·가용 상태 재확인, 실행 ID 중복 방지, 부작용 도구의 순차 실행, 취소·만료 보고 |
| `src/main/tools/capability-registry.ts` | 도구별 가용 상태와 리비전. 앱 도구는 macOS·Windows에서 `available`, 그 밖에는 `unsupported` |
| `src/main/tools/restore-target.ts` | 호출 직전 전면 앱 기록(APP-04). 로그아웃·계정 전환 시 비움 |
| `src/main/platform/macos-app-control.ts` | macOS 앱 목록·실행·전환·전면 앱 조회·URL 전달 |
| `src/main/platform/windows-app-control.ts` | Windows 앱 목록·실행·전환·전면 앱 조회·URL 전달 |
| `src/main/platform/app-control-support.ts` | macOS·Windows 앱 어댑터가 함께 쓰는 실패·관측 결과 생성, 확인 폴링, URL 전달 |
| `src/main/platform/command-runner.ts` | 고정 실행 파일과 인자 배열로만 OS 명령을 실행(셸 없음) |
| `src/main/platform/unsupported-app-control.ts` | 앱 어댑터가 없는 OS. 앱 도구는 `unsupported`, URL 전달만 동작 |
| `src/main/platform/macos-system-audio.ts` | `SystemAudioPort`(APP-07)의 macOS 구현. AppleScript 표준 명령으로 출력 볼륨·음소거를 바꾸고 다시 읽음 |
| `src/main/platform/unsupported-system-audio.ts` | 볼륨 어댑터가 없는 OS. 모든 호출이 `unsupported` |
| `src/main/platform/folder-opener.ts` | `FolderOpenPort`(APP-06). 별칭 검증, 표준 폴더 해석·존재 확인, 파일 관리자 전달 |

macOS 동작 기준은 다음과 같다.

- 앱 ID는 번들 ID다. 앱 목록은 `/Applications`·`/System/Applications`·사용자 `Applications`의 번들과 실행 중인 일반 앱을 합쳐 만들며, 자동화(Apple Events) 권한이 필요 없는 Foundation·AppKit 조회만 쓴다. 실행·전환 대상은 이 목록에 있는 ID만 허용하고 `open -b <번들 ID>`로 전달한다. ID 형식이 맞지 않거나 목록에 없으면 명령을 실행하지 않는다.
- 실행: 이미 실행 중이면 새로 시작하지 않고 `open -b`로 앞으로 가져온 뒤 전면 앱이 바뀌었는지 확인해 `confirmed`, OS가 포커스를 넘기지 않으면 `dispatched`(창이 없는 앱은 macOS의 기본 동작대로 창이 열린다). 아니면 `open` 후 프로세스가 나타나는지 5초까지 확인해 `confirmed`, 못 보면 `dispatched`.
- 전환: 실행 중인 앱만 대상이다(실행 중이 아니면 `not_found`이며 앱을 새로 시작하지 않는다). 전면 앱이 바뀌었는지 확인해 `confirmed`, 아니면 `dispatched`.
- 복귀: 기록한 앱을 전환한다. 창 단위 복귀는 접근성 권한이 필요해 macOS에서는 앱 단위까지만 지원한다.
- URL 열기: http·https만 허용하고 Electron `shell.openExternal`로 기본 브라우저에 전달한다. 결과는 `dispatched`다.
- 폴더 열기(APP-06, F-025): 별칭을 Electron `app.getPath`로 표준 폴더에 대응시키고, 폴더가 있는지 확인한 뒤 `shell.openPath`로 기본 파일 관리자(Finder·탐색기)에 전달한다. 해석한 경로는 보고·로그·오류 문구에 쓰지 않는다. 결과는 `dispatched`이며 창이 열렸는지 확인하지 못하므로 `confirmed`로 보고하지 않는다. 폴더가 없으면 `not_found`, 전달 실패는 `unavailable`이다. macOS와 Windows에서 `available`이고 그 밖의 OS는 `unsupported`다. 별칭 목록과 인자 형식은 서버 답변(2026-10-22)과 같다([서버 도구 인자](../architecture/server-integration.md#명령-계획과-실행-결과)).
- 시스템 볼륨·음소거(APP-07, F-026): macOS에서 `/usr/bin/osascript -e`로 `set volume output volume N`·`set volume output muted true|false`·`get volume settings`를 고정 실행 파일과 인자 배열로 실행한다(셸 없음). 이 명령은 다른 앱을 제어하지 않아 자동화 권한이 필요 없다. 스크립트에는 검증한 정수와 불리언만 들어간다. 변경 뒤 상태를 다시 읽어 요청과 일치하면 `confirmed`, 읽지 못하거나 장치가 값을 보고하지 않으면 `dispatched`, 일치하지 않으면 `unknown`으로 보고한다. 장치가 볼륨을 단계로 나누므로 요청과 ±4 이내는 일치로 본다. 상대 변경은 현재 값을 읽어 0~100으로 제한하며 값을 읽지 못하는 장치는 거절한다. macOS는 볼륨을 0보다 크게 바꾸면 음소거도 함께 풀리고 0으로 바꾸면 음소거가 되므로(실제 기기에서 확인), 어댑터는 음소거를 따로 바꾸지 않고 변경 뒤 읽은 음소거 상태를 그대로 보고한다. macOS에서만 `available`이고 Windows는 `unsupported`다(Windows 어댑터는 후속). 인자 형식은 서버 답변(2026-10-22)과 같다([서버 도구 인자](../architecture/server-integration.md#명령-계획과-실행-결과)).
- 최근 작업 전환은 입력 어댑터와 함께 구현하며 지금은 `unsupported`다.

Windows 동작 기준은 다음과 같다(APP-01~04, F-043).

- 앱 ID는 시작 메뉴 앱의 AppUserModelID(AUMID)다. 앱 목록은 `Get-StartApps`가 알려 주는 앱이며(패키지 앱·데스크톱 앱 모두), 실행·전환 대상은 이 목록에 있는 ID만 허용한다. ID에 제어 문자·따옴표·`<>|*?`가 있거나 앞뒤 공백이 있거나 512자를 넘으면 목록에서 빼고 실행하지 않는다.
- OS 호출은 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand`로 고정 스크립트만 실행하고 요청 값은 스크립트에 넣지 않는다(셸 없음). 설치 앱 조회는 시작 메뉴 바로가기(.lnk)의 실행 파일을 함께 읽으며 60초 동안 재사용하고, 실행 상태는 매번 새로 읽는다. 실행·전환은 `explorer.exe shell:AppsFolder\<AUMID>`로 전달한다(이 실행기는 성공해도 종료 코드 1을 줄 수 있어 0·1만 전달 성공으로 본다).
- 실행 중 판별: 보이는 최상위 창(가려진 창 제외)을 가진 프로세스의 실행 파일 경로로 판단한다. 패키지 앱은 `WindowsApps` 경로의 패키지 패밀리가 AUMID와 같을 때, 데스크톱 앱은 시작 메뉴 바로가기의 실행 파일과 경로가 같을 때 해당 앱으로 본다. 패키지 앱의 창은 `ApplicationFrameHost`가 대신 가지므로 그 안의 실제 프로세스를 쓴다. 여러 앱이 같은 프로그램을 가리키거나(명령 프롬프트·설치 관리자·파일 관리자), 실행 파일이 아닌 바로가기이거나, 바로가기를 읽지 못하면 그 앱은 `unknown`이며 실행·전환 결과를 `confirmed`로 보고하지 않고 `dispatched`로만 보고한다.
- 실행: 이미 실행 중이면 새로 시작하지 않고 앞으로 가져온 뒤 전면 앱이 바뀌었는지 2초까지 확인해 `confirmed`, 아니면 `dispatched`(Windows가 포커스 이동을 막을 수 있다). 실행 중이 아니면 전달 후 프로세스가 나타나는지 8초까지 확인한다. 전환·복귀는 실행 중인 앱만 대상이며(`stopped`이면 `not_found`) 상태를 알 수 없는 앱은 `unknown`으로 전달만 한다. 복귀는 앱 단위까지만 지원한다. 전면 앱 조회는 호출 직전 창을 먼저 읽고 Jarvis 자신이거나 목록에 없는 프로그램이면 대상 없음이다.
- 한계: 다른 가상 데스크톱에 있는 창은 가려진 창으로 보여 실행 중으로 세지 않을 수 있다. 관리자 권한으로 실행 중인 앱의 상태는 읽지 못할 수 있다. 앱 코드 → AUMID 매핑은 [명령 번역기](../architecture/server-integration.md#구현-현황-명령-번역기와-결과-매핑)를 따른다.
- 개발용: 패키징되지 않은 앱에서 `JARVIS_TOOL_SELFTEST='[도구 요청 JSON 배열]'`을 주면 로그인 직후 순서대로 실행하고 `TOOL_SELFTEST` 줄로 보고를 출력한다.

### 대화와의 연결 (F-020)

F-020([#34](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/34))에서 어시스턴트가 한 요청 동안 부르는 도구를 `ToolExecutor`로 실행하고 결과를 대화에 보여 주는 연결부를 구현했다. 서버 어댑터는 포함하지 않으며 개발용 대역으로 검증한다.

아래는 현재 구현이다. 서버 ERD 반영 목표인 실행 전 응답·명령 목록과 명령별 결과 보고는 [AI-02~04](speech.md#대화-생성과-요청-완료)에 따라 후속 연결한다. 현재 `respond` 반환 시 도구 호스트를 닫는 동작을 실행 전 안내 수신에 적용해서는 안 된다.

| 위치 | 책임 |
| --- | --- |
| `src/main/conversation/ports.ts` | `AssistantPort.respond`가 받는 `AssistantTools`(가용 도구 스냅샷, 도구 실행)와 `ToolRequest` |
| `src/main/conversation/turn-tools.ts` | 요청 하나 동안의 도구 호스트. 검증·실행·취소·보고·사용자 알림 |
| `src/main/tools/describe-report.ts` | 실행 보고를 사용자 문장으로 바꿈 |
| `src/main/speech/remote-speech/dev-intents.ts` | 개발용 대역이 평문 요청을 도구 호출로 바꿈(앱·주소·이전 작업·"○○ 폴더 열어줘"·볼륨·음소거) |

- 도구 호스트는 요청마다 새로 만들어 `ConversationManager`가 어시스턴트에 넘긴다. 어시스턴트가 보내는 명령은 신뢰하지 않고 스키마로 검증한다(알 수 없는 도구·잘못된 인자·`http/https` 밖 주소는 실행하지 않고 `rejected`로 보고). 실행 직전 인증·가용 상태 재확인과 중복 방지는 `ToolExecutor`가 맡는다.
- 어시스턴트가 정한 `executionId`는 요청 ID를 붙인 이름 공간으로 실행기에 전달하고 보고에는 받은 ID를 그대로 돌려준다. 같은 요청 안에서 같은 ID가 다시 오면 첫 결과를 돌려주고 다시 실행하지 않으며, 다른 요청의 같은 ID는 서로 영향을 주지 않는다.
- 요청당 도구 호출은 8회(유효하지 않은 요청 포함)까지다. `expiresInMs`는 호출이 도착한 시점부터의 로컬 단조 시계 기한으로 바꿔 실행기에 넘기고, 이미 지난 요청은 시작하지 않는다. `capabilityRevision`은 어시스턴트가 오래된 가용 상태로 요청했는지 판단하는 데 쓰도록 스냅샷에 포함하며 가용 여부는 실행 직전에 다시 확인한다.
- 요청이 끝나면(응답·실패·취소·시간 초과·대화 종료·로그아웃·일시 중지) 도구 호스트를 닫는다. 이후 도착한 호출은 `cancelled`로 거절하고, 아직 실행 중인 도구에는 취소를 전달하며 대기 중인 실행은 시작하지 않는다. 이미 시작된 OS 동작은 되돌렸다고 가정하지 않는다.
- 사용자에게는 도구 실행마다 한 줄을 보여 준다(`실행: …`). 성공·요청 전달(`dispatched`)·확인 불가·실행 전 취소/만료/거절·실패(영향 없음/있을 수 있음)를 구분하고, 알려진 앱은 표시 이름을 쓴다.
- 개발용: `JARVIS_DEV_SPEECH=1`일 때 대역이 글·음성 입력의 평문을 읽어 도구를 부른다. `앱 목록 알려줘`, `사파리 열어줘`(목록 조회 후 실행), `유튜브 열어줘`·`https://… 열어줘`, `이전 작업으로 돌아가줘`를 지원하고 결과로 응답 문구를 만든다.

