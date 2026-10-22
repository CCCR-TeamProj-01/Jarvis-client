# 서버 연동과 실행 계약

서버 역할, REST 전송 계약, 취소·만료·중복 실행 규칙의 원본 문서다.

2026-10-21 서버 ERD 수정 방향([#43](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/43))과 최종 ERD([#47](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/47))를 반영한 목표 계약이다. 2026-10-22 서버 REST API 명세([#56](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/56))를 대조해 전송 방식을 WebSocket이 아닌 REST 폴링으로 정했다. 엔드포인트와 JSON 필드의 원본은 서버의 REST API 명세이며 이 문서는 클라이언트가 지켜야 할 의미 계약이다. 실제 HTTPS 어댑터는 미구현이다. 미확정 정책과 ERD 내부 불일치는 [결정 목록](../delivery/validation.md#서버-erd-반영-후-결정-목록)에서 관리한다.

## 서버 모듈

| 모듈 | 주요 책임 |
| --- | --- |
| AuthAndDevice | 아이디·비밀번호 가입·로그인·중복 확인, 세션 검증·갱신·폐기, 기기 소유권, 연결 세션, 대상 기기 명시 |
| RequestOrchestrator | 요청 상태·취소·기한·추가 질문·결과 응답 조정 |
| SpeechService | 완료 발화의 STT, 확정된 응답의 TTS, 음성 요청 취소·기한·오류 처리 |
| Agent | 의도 해석, 가용 도구 선택, 구조화된 인자 생성 |
| ClientToolGateway | 기기별 명령 대기열 제공(기기가 폴링으로 수령), 결과 상관관계 관리 |
| Calendar | 자체 일정과 Google 일정의 저장·기간 조회·동기화, 외부 계정 연결·토큰 갱신·해제 |
| Activity | 실행 이력 수집·조회·삭제, 이벤트 중복 제거 |
| Recommendation | 연관도 계산·노출 판단·승인 상태·효과 집계 |
| Operations | 오류·응답 시간·사용량, 운영 화면용 집계 |

서버 구현 언어와 프레임워크는 미확정이다. HTTP API·모듈 경계를 먼저 고정하고 언어 선택과 분리한다. MySQL을 주 저장소로 사용하며, 초기 MVP에서 별도 메시지 브로커나 벡터 DB를 필수로 두지 않는다.

## REST 전송 계약

서버는 기준 경로 `/api/v1`의 REST API만 제공한다. WebSocket과 서버 푸시는 없고, 클라이언트가 주기적으로 조회(폴링)해 명령과 추천을 받는다. 로컬 개발 서버는 `http://127.0.0.1:8000/api/v1`이며 그 밖의 환경은 HTTPS만 사용한다. 보호 API는 `Authorization: Bearer <접근 토큰>`을 쓰고 모든 서버 호출은 Main이 수행한다. Renderer는 서버 주소와 토큰을 다루지 않는다.

| 영역 | 클라이언트가 쓰는 엔드포인트 | 구현 순서 |
| --- | --- | --- |
| 인증·기기 | `POST /auth/register`, `/auth/login`(기기 정보 포함), `/auth/refresh`, `/auth/logout`, `GET /auth/me` | 인증 어댑터 |
| 대화·요청 | `POST /conversations`, `POST /conversations/{id}/messages`(글 JSON·음성 multipart), `GET /requests/{request_id}` | 대화·요청 |
| 명령 | `GET /device/commands/pending`, `POST /commands/{command_id}/results` | 명령 폴러 |
| 음성 출력 | `POST /speech/syntheses`(답변 텍스트 → 오디오) | 음성 |
| 설정·앱 | `GET·PATCH /me/settings`, `GET·PATCH /device/apps` | 후속(설정 화면·수집 동의) |
| 활동·삭제 | `POST /activities/batches`, `POST·GET /history-deletions` | 후속 |
| 추천 | `GET /recommendations/pending`, `POST /recommendations/{id}/responses` | 후속 |

아이디 중복 확인의 엔드포인트는 현재 서버 명세에 없다([계정 인증 계약](#계정-인증-계약)). 캘린더·할 일·알림·운영 이벤트·제스처 세션 API는 현재 클라이언트 요구사항에 없고 관리자 API는 클라이언트 범위가 아니다. 요구사항이 정해지면 같은 방식으로 추가한다. 엔드포인트의 요청·응답 본문은 서버 명세가 원본이므로 이 문서에 복제하지 않는다.

| 폴링 | 활성 | 백그라운드 | 오류 시 |
| --- | --- | --- | --- |
| 요청 상태(`GET /requests/{id}`) | 0.5~1초 | — | 지수 백오프, 최대 10초 |
| 대기 명령(`GET /device/commands/pending`) | 2초 | 10초 | 최대 30초. 401이면 토큰 갱신 |
| 추천(`GET /recommendations/pending`) | 요청 완료 직후와 30초 | 60초 | 최대 5분 |

오류 응답은 `{"error": {"code", "message", "request_id", "details"}}` 형식으로 통일되며(2026-10-22 명세) 같은 `request_id`가 `X-Request-ID` 헤더에도 담긴다. 422의 `details.fields`에는 오류 위치와 종류만 있고 입력값은 돌려주지 않는다. 클라이언트는 `code`로 분기하고 `message`는 사용자에게 보여주지 않는다. 호출 제한 응답에서 한때 `{"detail": {"code": ...}}`가 관찰되어 클라이언트는 두 형식을 모두 읽으며, 코드가 없는 `detail`(프레임워크 검증 오류 등)은 HTTP 상태로만 분류한다. 어댑터가 서버 오류 코드를 `ClientError`로 변환하며 서버의 `message`를 그대로 화면에 쓰지 않는다. `INVALID_SESSION`(401)은 세션 무효로 처리하고 `RATE_LIMITED`(429)는 `Retry-After`를 존중해 재시도를 늦춘다. 대화 생성 같은 생성 요청은 `Idempotency-Key`로, 요청 제출은 클라이언트가 만든 `request_id`로, 명령 결과는 `(command_id, attempt_no)`로 재전송을 멱등하게 한다.

정수 PK(`device_id`·`command_id`·`message_id`·`recommendation_id` 등)는 JSON 숫자로 받는다. 경계에서 `Number.isSafeInteger`로 안전한 정수(2^53-1 이하)인지 검증하고 아니면 응답을 계약 위반으로 거부한다. 내부에서는 문자열 식별자로 변환해 쓴다. `user_id`·`session_id`·`deletion_id`는 UUID, `conversation_id`·`request_id`는 접두가 붙은 문자열이다.

### 구현 현황: 공통 서버 클라이언트

F-027([#58](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/58))에서 서버 호출의 공통 기반을 구현했다. 인증·대화·명령 엔드포인트 호출은 이 위에 올라가는 후속 구현이며, 아직 앱 시작과 연결하지 않았으므로 사용자에게 보이는 동작은 없다.

| 위치 | 책임 |
| --- | --- |
| `src/main/connection/server-config.ts` | 서버 기준 주소. 패키징되지 않은 앱의 `JARVIS_SERVER_URL`만 읽는다. 없으면 `unconfigured`, 잘못되면 `invalid`로 연결 불가처럼 동작한다. `https`만 허용하고 `http`는 `127.0.0.1`·`localhost`·`::1`에만 허용한다. 인증 정보·쿼리·해시·앞뒤 공백은 거부한다. 패키징된 빌드는 환경변수로 주소를 바꿀 수 없고 운영 주소 주입 방식은 서버 주소가 정해질 때 정한다 |
| `src/main/connection/server-client.ts` | `ServerClient.request`. 고정 형식의 경로·`Idempotency-Key`만 허용하고 기준 주소의 출처·경로를 벗어나는 요청(인코딩된 `..` 포함)을 보내기 전에 거절한다. 접근 토큰은 `Authorization: Bearer`로만 보내고 토큰이 없거나 형식이 맞지 않으면 보내지 않는다. 시간 초과(기본 10초)·취소·응답 크기 제한(기본 1MB)·리다이렉트 거부를 적용하고, 성공 본문은 JSON 형식과 호출자의 스키마로 검증한다. 자동 재시도는 하지 않는다 |
| `src/main/connection/server-errors.ts` | 서버 오류 코드(없으면 HTTP 상태) → `ClientError` 변환과 코드별 고정 문구. 서버의 `message`는 쓰지 않는다 |
| `src/main/connection/server-ids.ts`, `server-clock.ts` | 정수 ID의 안전 정수 검증과 문자열 변환. 응답 `Date` 헤더로 서버와 로컬의 시계 차이 추적 |
| `src/main/connection/create-server-client.ts`, `create-default-server-client.ts` | 주소 확인 뒤 클라이언트를 만드는 조립. 실제 전송은 Electron `net.fetch`(시스템 프록시·인증서 저장소)를 주입한다 |

- 결과는 `ServerResult`다. 실패에는 `ClientError`와 별도로 전송 정보(`delivery`, HTTP 상태, 서버 오류 코드, 요청 ID, `Retry-After` 지연)를 담는다. `delivery`는 요청이 서버에 닿았는지를 나타낸다. 연결 거부·이름 해석 실패·연결 시간 초과·인증서 오류는 `not_sent`(다시 시도해도 안전), 요청을 보낸 뒤의 시간 초과·연결 끊김과 알 수 없는 오류는 `no_response`(서버가 처리했을 수 있음), 응답을 받은 경우는 `responded`다. 갱신 토큰 응답 유실 처리([계정 인증 계약](#계정-인증-계약))가 이 구분을 쓴다.
- 비밀번호·토큰·요청 본문·서버가 보낸 문구·스키마 오류의 세부 내용은 결과와 오류 문구에 넣지 않는다.
- 서버 오류 응답은 `error`와 `detail` 두 형식을 모두 읽는다.
- 접근 토큰은 요청 때마다 비동기로 받을 수 있고(만료 직전이면 갱신 후), 보호 요청이 세션 무효(401)로 거절되면 갱신을 한 번 시도한 뒤 같은 요청을 한 번만 다시 보낸다. 로그인 요청과 갱신 요청처럼 토큰을 보내지 않는 요청, 취소된 요청에는 적용하지 않는다.
- 아직 없는 것: multipart 음성 업로드와 오디오 응답 처리(음성 단계), 토큰 갱신과 단일 비행 처리는 서버 인증 어댑터에서, 보호 API 호출 중의 자동 갱신은 F-029에서 구현했다([F-028](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/60), [서버 인증 어댑터](../features/auth.md#서버-인증-어댑터-f-028)).

## 계정 인증 계약

제품 동작·입력 규칙과 설치 식별자의 수명은 [AUTH-01~07](../features/auth.md)을 따른다. 아래는 최종 ERD 3절·6-1절에 따라 Main의 인증 어댑터가 서버와 주고받을 연산의 의미다.

| 연산 | 필수 계약 |
| --- | --- |
| 아이디 중복 확인 | `loginId`에 대한 사용 가능·중복·유효하지 않은 입력·실패 구분. 가입 시 최종 유일성 검사를 대체하지 않음. 서버 엔드포인트는 `POST /auth/username-checks`(요청 `{username}`, 응답 `200 {username(소문자), available}`, 형식 오류 `422`, 호출 한도 초과 `429`)다. 확인 실패(통신 오류·`429`·`422`)는 사용 가능으로 처리하지 않는다 |
| 회원가입 | `loginId`·`password`를 입력으로 받고 가입 성공·아이디 중복·입력 오류·실패를 구분. 서버에서 같은 정규화 규칙과 저장소 제약으로 동시 가입의 중복 방지. 재입력 값이나 클라이언트의 사용 가능 플래그는 신뢰 근거가 아님. 서버가 확정한 입력 규칙(2026-10-22)은 아이디 영문 대소문자·숫자·`_` 3~32자(소문자로 저장, 앞뒤 공백은 제거하지 않고 거부)와 비밀번호 15~128자(문자 종류 제한 없음, 앞뒤 공백 포함 정규화하지 않음)이며 로그인 비밀번호는 1~128자다 |
| 로그인·기기 등록 | 자격 증명과 Main의 설치 식별자 `device_key`·기기 이름·OS·클라이언트 버전을 함께 전달. 서버가 `(user_id, device_key)`로 기기를 찾거나 만들고 `AUTH_SESSIONS.device_id`에 연결한 뒤 공개 사용자·기기 정보와 Main 내부 인증 자격 증명 반환. 반복 로그인은 같은 계정의 같은 기기로 수렴. 잘못된 인증 정보·일시 제한·서버 오류·통신 실패를 구분. 기기 정보는 `device_key`·`device_name`·`platform`(`windows`/`macos`, Main이 `win32`/`darwin`에서 변환)·`client_version`이며 응답은 토큰 한 쌍·세션 ID·공개 사용자·기기(`device_id`)다 |
| 세션 검증·갱신 | 보호 저장된 자격 증명의 현재 유효성과 사용자·기기 연결을 확인하고 필요 시 새 토큰 쌍으로 갱신. 무효·만료·폐기와 일시 통신 실패 구분. 교체한 자격 증명은 보호 저장소에도 반영. 복구는 저장된 접근 토큰이 유효하면 `GET /auth/me`로, 만료됐으면 `POST /auth/refresh` 뒤 `GET /auth/me`로 사용자·기기 연결을 확인 |
| 로그아웃 | 현재 로그인 세션의 폐기. 다른 PC 세션의 일괄 폐기를 의미하지 않음. 반복 요청에 안전하게 처리하며 클라이언트의 즉시 기능 차단·로컬 정리를 지연시키지 않음 |

접근 토큰은 발급 후 1시간, 갱신 토큰은 발급·갱신 후 30일 동안 유효하다. 갱신은 새 토큰 쌍을 발급하며 이전 갱신 토큰은 즉시 무효가 된다. 교체된 갱신 토큰이 다시 사용되면 서버가 해당 세션을 폐기한다. Main은 같은 세션의 갱신을 직렬화하고 교체 전 토큰을 자동 재사용하지 않는다. 접근·갱신 토큰 한 쌍은 한 값으로 묶어 보호 저장소(`SessionCredential`)에 저장한다. 교체 응답이 유실되면 이전 갱신 토큰의 재전송이 재사용으로 탐지되어 세션이 폐기될 수 있어 서버가 유예를 지원한다(2026-10-22 서버 답변). 직전 갱신 토큰이 회전 후 30초 안에 한 번 더 오면 세션을 폐기하지 않고 새 토큰 쌍을 다시 발급하며(직전에 발급한 쌍은 무효이고 같은 쌍을 다시 돌려주지는 않는다. 서버는 토큰 해시만 저장한다), 30초가 지났거나 같은 직전 토큰이 두 번째로 다시 오면 `REFRESH_TOKEN_REUSED`로 세션을 폐기한다. 서버에는 회전 시각 컬럼(`AUTH_SESSIONS.rotated_at`) 마이그레이션이 필요하고, 유예 30초 동안 탈취된 토큰도 한 번 더 쓸 수 있다는 보안 비용이 있다. 클라이언트는 서버에 닿지 않았음이 확실한 실패(연결 거부·이름 해석 실패 등)를 일시 장애로 보고 자격 증명을 유지한 채 재시도한다. 요청을 보낸 뒤 응답을 받지 못했거나 성공 응답을 읽지 못한 갱신은 첫 시도 후 20초 안에 같은 토큰으로 한 번만 다시 보내고, 그 반복도 실패하면 교체 여부를 알 수 없으므로 이전 토큰을 다시 쓰지 않고 자격 증명을 제거해 재로그인을 안내한다. 서버에 유예가 배포되기 전에는 반복이 `REFRESH_TOKEN_REUSED`로 끝나 재로그인이 된다. 새 토큰을 받았으나 보호 저장에 실패하면 현재 실행의 로그인은 유지하되 다음 실행의 복구가 불가함을 알린다.

서버는 비밀번호를 해시로 저장하고 로그인·가입 입력을 다시 검증한다. 비밀번호·토큰은 요청·오류 로그에 기록하지 않는다. 모든 API는 토큰에서 사용자·기기·세션을 확인하며 매 요청 본문에 `userId`·`deviceId`를 중복 요구하지 않는다. 클라이언트가 보낸 식별자만으로 소유권을 인정하지 않는다.

로그아웃·사용자 전환 이후 이전 세션의 폴링 응답·음성·캘린더·추천 응답은 적용하지 않는다. 폴링과 재시도는 현재 인증 세대에만 연결하며, 기록 대기열도 인증된 같은 사용자의 데이터만 정책 검증 후 전송한다. 가입·로그인·중복 확인과 세션 복구 자체는 미로그인 상태에서도 호출 가능한 인증 전용 연산이다.

## 대화·메시지와 요청 식별

서버에서 `USER_REQUESTS`의 요청 메타데이터를 `CONVERSATION_MESSAGES`로 통합해도 클라이언트의 요청 단위는 유지한다. DB 행과 클라이언트 내부 상태를 같은 구조로 만들지 않는다. 메시지 본문의 저장·보관은 [데이터와 보안](data-security.md#대화와-일정-저장)을 따른다.

| 식별자 | 의미와 연결 |
| --- | --- |
| `conversation_id` / 내부 `conversationId` | 서버에 생성한 활성 대화의 외부 식별자. DB 내부 `conversation_pk`는 클라이언트에 필요하지 않음 |
| `request_id` / 내부 `requestId` | 클라이언트가 입력 처리 전에 생성하는 한 요청의 식별자. 음성 인식·응답·취소·명령을 연결하며 DB 메시지 ID 발급 전에도 존재 |
| `message_id`, `source_message_id` | 서버가 저장한 메시지와 명령의 원인 메시지. 한 사용자 메시지에 여러 명령 연결 가능. 전송 이벤트의 `messageId`와 구분 |
| `command_id` | 서버가 생성한 명령. 사용자 메시지 또는 승인된 추천과 연결. 재시도해도 같은 명령 |
| 내부 `executionId`, 외부 `command_id` + `attempt_no` | 명령의 실행 시도. Main의 안정적인 실행 ID를 외부 명령·시도 쌍에 매핑하고 재전송 동안 유지. 별도 `executionId` wire 필드의 필요 여부는 API 합의 사항이며 결과 행의 `result_id`와 구분 |
| `recommendation_id` | 승인·거절·닫기·만료와 승인으로 생성된 명령의 상관관계 |
| `event_key` | 앱 활동 한 건의 안정적인 이벤트 ID. 실행 시도와 별개이며 수집·전송 중복 제거에 사용 |

Main은 활성 대화가 없으면 인증된 현재 기기로 서버 대화를 생성한 뒤 입력을 제출한다. 서버의 생성 응답은 호출 당시 인증·로컬 대화 세대가 유효할 때만 적용한다. 생성 요청의 재전송은 같은 생성 식별자로 중복을 막으며 생성 실패·취소로 명령을 실행하지 않는다. `POST /conversations`는 `Idempotency-Key`를 지원하며 생성 기한과 재시도 횟수는 구현 이슈에서 정한다. 현재 로컬 ID 생성 구현과의 차이는 [AI-04](../features/speech.md#대화-생성과-요청-완료)에 둔다.

요청은 `POST /conversations/{conversation_id}/messages`로 제출한다. 글은 JSON(`request_id`·`input_method=text`·`content`), 음성은 multipart(`request_id`·`input_method=voice`·`audio`)이며 `202`로 접수된다. 한 대화에서는 한 번에 한 요청만 처리하며(처리 중이면 `CONVERSATION_BUSY`, 409) 같은 `request_id`와 같은 본문의 재전송은 기존 상태를 돌려준다(다른 본문은 `REQUEST_ID_CONFLICT`). 결과는 `GET /requests/{request_id}`를 폴링해 받는다. `processing_status`는 `queued` → `processing` → `success`·`failed`·`rejected`이고 `transcript`(음성의 인식 텍스트)·`assistant_messages`(응답 문장)·`commands[].latest_result`를 담는다. `success`는 서버 처리 완료(음성이면 STT, AI 분석, 답변 생성, 명령 생성, 서버가 실행하는 도구의 실행까지)이며 PC 명령의 실행 완료를 기다리지 않는다. PC 명령의 최종 결과는 `commands[].latest_result`(보고 전에는 null)나 `GET /commands/{command_id}`로 확인한다. `failed`는 서버 처리 오류(STT·AI·내부 오류), `rejected`는 정책상 거부(차단된 앱·허용되지 않은 요청)다(2026-10-22 명세).

### 구현 현황: 명령 번역기와 결과 매핑

F-032([#69](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/69))에서 서버 명령과 로컬 도구 사이의 변환을 `src/main/commands/`에 순수 로직으로 구현했다. 폴링·실행 저널·결과 전송은 아직 없다(후속).

- `server-command.ts`: 명령 항목 스키마(`command_id`는 안전 정수, `requested_at`은 시간대가 있는 ISO 8601, 모르는 필드는 무시)와 `(command_id, attempt_no)`에서 만드는 안정적인 `executionId`.
- `command-translator.ts`: 위 도구 인자 표대로 `ToolCommand`로 바꾸고 기존 도구 계약으로 다시 검증한다. 모르는 키·형식 오류는 `rejected`(`validation`, `invalid_input`), 허용 목록에 없는 앱 코드와 앱 명령의 `arguments`는 같은 검증 거절이다. 클라이언트가 실행하지 않는 명령(`apps.list`·`apps.close`·`browser.search`·`system.status`)과 모르는 `command_type`은 `rejected`(`capability`, `unsupported`)다.
- `app-codes.ts`: 앱 코드 14개를 macOS 번들 ID로 매핑한다. 이 Mac에서 설치된 앱의 번들 ID를 읽어 확인한 것은 `chrome`·`vscode`·`notion`·`slack`·`kakaotalk`·`terminal`·`explorer`(Finder)·`notepad`(TextEdit)·`calculator`이고, `edge`·`whale`·`teams`·`outlook`·`spotify`는 제조사가 공개한 ID이며 기기에서 확인하지 못했다. 잘못된 ID는 "설치되어 있지 않음"으로만 나타난다(앱 제어가 OS가 알려 주는 앱 목록에서만 대상을 찾는다). Windows는 실행 파일 매핑이 없어 `rejected`(`capability`, `unsupported`)다.
- `result-mapper.ts`: `ToolExecutionReport`를 위 결과 매핑 표와 `failure_stage` 표대로 서버 결과 본문으로 바꾼다. `result_message`는 도구 이름과 결과 종류로 만든 고정 문구라서 URL·경로·볼륨 수치·오류 원문이 들어가지 않는다. `app`은 앱 명령과 복귀(번들 ID가 고정 앱 코드 14개 중 하나일 때)에서만 붙는다.

### 구현 현황: 명령 실행 저널

F-033([#71](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/71))에서 `src/main/commands/command-journal.ts`에 실행 저널의 저장 계층을 구현했다. 폴러·결과 전송과 앱 연결은 아직 없다(후속). 위 [명령 전달 규칙](#명령-계획과-실행-결과)의 "이미 실행한 명령을 다시 받으면 재실행하지 않고 저장된 결과만 재전송한다"를 이 계층이 지킨다.

- 상태는 `started`(실행 직전에 디스크에 기록) → `finished`(결과 포함, 전송 대기) → `reported`(서버가 저장)다. `started`를 기록하지 못하면 명령을 실행하지 않는다. 이미 본 `(command_id, attempt_no)`는 `existing`으로 돌려주며 같은 명령의 동시 요청 중 하나만 시작된다.
- 앱이 실행 도중 종료되어 다음 시작에서도 `started`로 남은 명령은 `unknown`(`failure_stage=observation`) 결과로 바꾸고 다시 실행하지 않는다.
- 저장 내용은 사용자 ID·명령 ID·시도 번호·상태·고정 문구 결과뿐이다. 명령 인자(URL·폴더)와 서버·OS 오류 원문은 담지 않는다. 파일 `command-journal.json`은 `installation.json`과 같은 소유자 전용 원자적 교체 방식으로 `userData`에 저장하며 설치 식별자·계정 설정과 섞지 않는다.
- 사용자마다 격리하고 다른 계정이 로그인하면 이전 사용자의 기록을 지울 수 있다(`purgeOthers`). 보관 기한은 7일, 사용자당 상한은 500개이며 상한을 넘으면 보고가 끝난 오래된 항목부터 지운다(보고 대기 결과는 지우지 않음).
- 읽거나 해석할 수 없는 파일(알 수 없는 버전·필드 포함)은 덮어쓰지 않고 모든 호출이 `unavailable`이다. 무엇을 실행했는지 모르는 채 실행하면 한 명령을 두 번 실행할 수 있기 때문이다.

### 구현 현황: 대화·요청 어댑터

F-030([#62](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/62))에서 글 입력 대화의 서버 어댑터(`src/main/conversation/server-assistant.ts`)를 구현했다. 서버 주소가 유효하고 `JARVIS_DEV_SPEECH=1`이 아니면 `AssistantPort`로 선택된다(개발용 대역이 우선, 서버가 없으면 연결 불가). 음성 입력은 아직 서버로 보내지 않고(음성 포트는 연결 불가 유지) 명령도 실행하지 않는다. 실제 서버와의 통합은 아직 확인하지 못했다.

- 서버 대화는 로컬 대화마다 한 번만 만든다(`POST /conversations`, 로컬 대화 ID에서 만든 `Idempotency-Key`). 응답이 유실되면 같은 키로 다시 보낸다. 서버 대화 ID와 요청 ID는 어댑터 안에서만 쓴다.
- 입력은 `POST /conversations/{conversation_id}/messages`(`request_id`는 `req_` + ULID 26자, `input_method=text`)로 제출한다. 요청 ID는 턴마다 한 번 만들고 모든 시도에 같은 값을 쓴다. 응답이 유실되면 같은 ID와 본문으로 최대 2번 다시 보내고(서버가 멱등 처리), `CONVERSATION_BUSY`는 1초씩 기다려 최대 5번 다시 보내며, 서버 대화가 없어졌으면(404) 새로 만들어 한 번만 다시 시도한다.
- 결과는 `GET /requests/{request_id}`를 0.5~1초 간격으로 폴링한다. 일시 오류(5xx·호출 제한·형식 오류)는 지수 백오프(최대 10초, 429는 `Retry-After` 이상)로 다시 시도하고 연속 5번 실패하면 오류를 돌려준다. 없는 요청·세션 종료 같은 오류는 바로 돌려준다. 어댑터 자신의 최대 대기는 60초이며 대화 관리자의 응답 제한(20초)과 취소가 먼저 적용된다.
- `success`는 어시스턴트 문장(비어 있지 않은 메시지를 줄바꿈으로 이어 붙임)을 화면 문장으로 쓴다. 명령이 포함된 응답에는 이 기기에서 명령을 아직 실행하지 않는다는 참고 문장을 덧붙인다. `rejected`는 `permission_denied`, `failed`는 `unavailable`로 바꾸며 서버의 오류 코드·문구는 쓰지 않는다. 알 수 없는 상태는 계속 기다린다. `success`는 서버 처리 완료로 취급하며 PC 명령의 실행 완료로 표시하지 않는다(명령 결과는 따로 확인한다).
- 사용자 입력·응답 문장·토큰은 오류 문구와 로그에 남기지 않는다.


최종 ERD 6-6절의 서버 문맥 기준은 메모리 보관 30분, 문맥이 없을 때 해당 대화의 최근 메시지 20개를 `message_id` 순서로 복구하는 방식이다. 앞부분이 잘려 호출과 짝이 맞지 않는 도구 결과는 제외한다. 서버 문맥 보관은 로컬 대화·음성 세션의 수명과 별개이며 끝낸 대화 ID를 다시 사용하지 않는다. 본문 미보관·삭제 후 복구 범위는 데이터 정책과 함께 합의한다.

사용자 입력은 `role=user`, `message_type=request`와 입력 방식으로 연결한다. 서버가 수신한 음성의 STT가 실패해도 같은 `request_id`의 오류를 추적하고 본문 없는 메시지를 허용한다. 클라이언트에서 업로드 전에 끝난 무음·취소 구간은 이 기록을 만들기 위해 전송하지 않는다. 서버가 원래 음성을 이미 받았다면 클라이언트의 후속 텍스트 제출을 두 번째 사용자 요청으로 저장하지 않도록 같은 요청 ID로 연결한다.

`input_method=gesture/ui`는 서버 요청을 만드는 명시적 동작을 표현할 수 있다. 커서 좌표·매 프레임·클릭·센서 중지 전체를 대화 메시지로 전환하거나 서버 처리에 종속시키지 않는다. 메시지 없는 명령을 지원한다면 대상 사용자·기기·요청 수명과 허용 진입점을 별도로 검증해야 하며 `source_message_id=NULL`만으로 자동 실행을 허용하지 않는다.

## 명령 계획과 실행 결과

서버는 사용자 요청에 연결된 명령을 만들고 실행 전 안내·구조화된 명령 목록·추천 정보를 반환할 수 있다. 클라이언트는 응답 문장에서 명령을 추출하지 않는다. 실행 전 응답을 표시한 시점과 요청 완료를 구분하는 제품 동작은 [AI-02~04](../features/speech.md#대화-생성과-요청-완료)를 따른다.

- 서버가 내리는 명령 항목은 `command_id`·`attempt_no`·`command_type`·`requested_app_code`·`arguments`·`requested_at`이다. 도구별 `arguments`의 스키마는 서버가 정하고, 클라이언트 어댑터가 이를 로컬 도구 요청으로 변환해 기존 입력 검증을 거친다. 검증에 실패하면 실행하지 않고 `rejected`로 보고한다. 명령에는 만료 시각·가용 상태 리비전·도구 버전이 없다. `requested_app_code`만으로 URL·복귀 등 모든 도구의 인자를 대체하지 않는다.
- 서버는 AI에 제공할 도구 정의와 계획을 관리한다. 클라이언트는 실행 직전에 지원 도구·권한·현재 가용 상태를 다시 검사한다. 기기의 지원 도구를 서버에 알리는 경로는 없으므로 지원하지 않는 도구는 결과 보고로 거절한다. 서버 공통 앱 코드와 로컬 OS 앱 ID의 매핑은 [앱 제어](../features/app-control.md#서버-도구와-앱-식별)를 따르며, 매핑표는 클라이언트가 내장하고 결과 보고의 `app`(`app_code`·`os_app_id`·`display_name`)으로 서버가 로컬 앱 ID를 알게 한다.
- 클라이언트 대상 명령만 Main의 실행기로 보낸다. 서버·외부 서비스 도구의 실행은 서버가 담당한다. 기본 대상은 요청이 들어온 현재 기기이며 다른 PC 원격 실행을 추가하지 않는다.
- 같은 요청의 부작용 명령은 지정 순서로 처리한다. 중간 실패 시 후속 명령을 계속할지·의존 명령만 중단할지와 실행 전 안내의 TTS 순서는 API 연동 전에 결정한다. 순서만으로 의존 관계를 추정하지 않는다.
- 추천 정보는 실행 명령이 아니다. [추천 승인](../features/activity-recommendation.md#추천-승인) 이후 서버가 생성한 명령을 실행한다.

명령은 대화와 별개로 기기 단위의 폴러가 `GET /device/commands/pending`에서 받는다. 현재 토큰의 기기에 속한 명령만 생성 순서대로 내려오며 추천 승인으로 생긴 명령도 같은 경로다. 결과를 보고하기 전까지 같은 명령이 다시 내려올 수 있어, Main은 `(command_id, attempt_no)`를 키로 하는 실행 저널을 로컬에 영속 보관한다. 이미 실행한 명령을 다시 받으면 OS 명령을 재실행하지 않고 저장된 결과만 재전송한다. 명령에 만료 시각이 없으므로 `requested_at`을 서버 시각으로 보고 응답으로 알게 된 서버와 로컬의 시계 차이를 보정해, 잠정 60초가 지난 명령은 시작하지 않고 `failed`(`failure_stage=timeout`, `error_code=expired`)로 보고한다. 지원하지 않는 도구·잘못된 인자·권한 없음은 `rejected`로 보고한다. 서버는 확인 상태가 없는 `system.power`를 목록에서 제외한다. 로그아웃·계정 전환 시 저널과 미보고 결과는 이전 사용자의 데이터로 분리하며 다른 계정에 재전송하지 않는다.

서버가 확정한 도구 인자(2026-10-22 서버 답변)는 아래와 같다. 키는 snake_case이고 클라이언트 어댑터가 로컬 도구 요청(`appId` 등)으로 변환한다. 명령 항목과 결과 보고의 형식은 이 표와 아래 설명이 현재 서버 구현 기준이며, 명령 `arguments`의 저장·전달 방식은 서버가 명령 API를 구현할 때 확정하므로 [서버 확인 항목](../delivery/validation.md#rest-api-명세-대조-결정2026-10-22)으로 남아 있다.

| `command_type` | `arguments` | 클라이언트 처리 |
| --- | --- | --- |
| `apps.launch`, `apps.activate` | `{}` + 최상위 `requested_app_code` | 앱 코드를 로컬 앱 ID로 해석해 실행 |
| `apps.close` | `{}` + `requested_app_code` | 클라이언트 도구가 없어 `rejected`(`unsupported`)로 보고 |
| `apps.list` | `{}` + 조회 대상 앱의 `requested_app_code`(서버 내부 이름은 `app_status`) | 서버의 의미는 **특정 앱의 상태 조회**다. 클라이언트 `apps.list`는 전체 목록을 돌려주므로 어댑터가 목록에서 해당 앱을 찾아 결과로 바꾼다 |
| `apps.restore` | `{}` | 그대로 |
| `browser.open` | `{"url": "https://…"}`(서버가 사이트 이름을 URL로 해석) | 그대로. http·https 검증 |
| `browser.search` | `{"query", "engine": "google"\|"naver"}` | 클라이언트 도구가 없어(#55 보류) `rejected`(`unsupported`) |
| `folder.open` | `{"alias": "downloads"\|"documents"\|"desktop"\|"pictures"}`(서버 도구가 지원하는 4개. 서버 문서에 있는 `home`·`music`·`videos`는 서버 도구 정의와 맞지 않아 현재 내려오지 않는다) | 그대로. 클라이언트 계약은 7개 별칭을 모두 받아 서버가 확장해도 바꾸지 않는다 |
| `system.volume` | `{"mode": "set", "level": 0~100}` 또는 `{"mode": "adjust", "delta": -100~100}` | 그대로 |
| `system.mute` | `{"muted": true\|false}` | 그대로 |
| `system.status` | `{}`(현재는 볼륨·음소거 상태 조회) | 클라이언트 도구가 없어 `rejected`(`unsupported`)로 보고. 도구 추가와 결과의 형식은 서버 확인 항목 |

서버 쪽에 알려진 제한이 있다(2026-10-22 서버 답변). 상대 볼륨(`adjust`)은 서버의 인자 변환에 오류가 있어 서버 수정 전에는 올바른 인자가 오지 않을 수 있으며, 형식이 깨진 인자는 인자 검증에서 `rejected`(`validation`)로 보고한다. `browser.open`의 브라우저 지정은 서버에서 버려져 클라이언트는 기본 브라우저로 연다. 전체 창 닫기와 특정 창 닫기는 하나의 `apps.close`로 합쳐진다. 로컬 도구에만 있는 `app_install`은 REST 명령으로 매핑되지 않으며, 밝기·스크린샷·클립보드·파일 검색·전원은 계획 단계 도구라 명령으로 내려오지 않는다.

허용 앱 코드는 14개로 고정된다: `chrome`·`edge`·`whale`·`vscode`·`notion`·`slack`·`teams`·`outlook`·`spotify`·`kakaotalk`·`terminal`·`explorer`·`notepad`·`calculator`. 결과 보고의 `failure_stage`는 실패가 아니면 null이고 아래 표의 9개 중 하나다. 클라이언트가 보내는 `error_code`는(최대 64자, `A-Za-z0-9_.:-`) 소문자 snake_case(`permission_denied`·`unsupported`·`invalid_input`·`not_found`·`cancelled`·`expired`·`unavailable`·`internal`·`unknown`)이며 서버가 만드는 코드는 대문자 snake_case다. 확인 불가는 실패와 구분해 `status=unknown`으로 보고하며 자동 재실행하지 않는다. 요청 상태의 `failed`는 서버 처리 오류(STT·AI·내부), `rejected`는 정책상 거부(차단된 앱·허용되지 않은 요청)다.

| `failure_stage` | 의미(서버 명세) | 로컬 상황과 `status`·`error_code`(잠정 매핑, 결과 보고 구현 때 확정) |
| --- | --- | --- |
| `validation` | 인자 검증 실패 | 도구 인자 검증 실패. `rejected`, `invalid_input` |
| `capability` | 미지원·권한 없음 | 지원하지 않는 도구·OS(`unsupported`), 권한 철회·인증 만료(`permission_denied`). `rejected` |
| `precondition` | 앱 미설치·대상 없음 등 선행 조건 불충족 | 앱·폴더를 찾지 못함. `failed`, `not_found` |
| `dispatch` | OS 전달 실패 | 앱 실행·파일 관리자·브라우저 전달 실패. `failed`, `unavailable` |
| `execution` | 실행 중 오류 | 실행 도중 오류. `failed`, `unavailable` 또는 `internal`(부작용 가능성은 `observation_status=unknown`) |
| `observation` | 실행 후 확인 실패 | 실행했는지 확인하지 못함. `status=unknown`, `unknown` |
| `timeout` | 기한 초과 | 명령 기한이 지나 시작하지 않음. `failed`, `expired` |
| `cancellation` | 취소 | 사용자 취소·로그아웃. `failed`, `cancelled` |
| `internal` | 클라이언트 내부 오류 | 예상하지 못한 내부 오류. `failed`, `internal` |

`COMMAND_REQUESTS`는 명령 정보를, `COMMAND_RESULTS`는 실행 시도별 결과를 받는다. 기존 로컬 `ToolExecutionReport`와 다음 외부 보고의 변환은 Main의 서버 어댑터가 담당한다.

| 결과 정보 | 보고 규칙 |
| --- | --- |
| 명령·실행 시도 | `command_id`·`attempt_no`로 보고 시도를 식별하고 Main 내부 `executionId`와 매핑. `request_id` 및 원인 메시지와 상관관계를 유지 |
| 결과·관측 | 실행 전 미시작, 관측됨, 실패, 확인 불가를 구분하고 아래 표로 서버 `status`·`observation_status`에 매핑. `confirmed`·`dispatched`·`unknown`과 실패의 부작용 가능성을 `error_code`·`failure_stage`로 보존 |
| 취소·만료 | 취소 요청과 실제 실행 여부를 분리. 이미 일어난 OS 동작의 결과를 취소 성공으로 덮어쓰지 않음 |
| 오류 | 기계 판정은 `error_code`·`failure_stage` 사용. `result_message`는 사용자 안내용으로 제한하며 스택·토큰·임의 서버/OS 오류 원문을 넣지 않음. 검색어·전체 URL·파일 경로·클립보드 내용·스크린샷 경로·볼륨 같은 시스템 수치도 넣지 않으며(서버는 저장하지 않음) 화면용 보고 문장을 그대로 보내지 않음 |
| 시각 | 클라이언트의 시작·종료 시각과 서버 수신 시각 `reported_at` 구분. 시간 형식은 [시각 계약](#시각-계약) 참조 |

로컬 `ToolOutcome`을 서버 값으로 바꾸는 규칙은 다음과 같다. `status`는 확정한 결정이고 `observation_status`는 서버 확인 전의 잠정 매핑이다.

| 로컬 결과 | 서버 `status` | 서버 `observation_status`(잠정) |
| --- | --- | --- |
| `observed` | `success` | 관측의 `confirmed`·`dispatched`·`unknown`. 관측 수준이 없는 도구(앱 목록 조회)는 `not_applicable` |
| `failed` | `failed` | 부작용이 없으면 `not_applicable`, 있을 수 있으면 `unknown` |
| 실행 전 거절(미지원·잘못된 인자·권한 없음) | `rejected` | `not_applicable` |
| 실행 전 취소·만료 | `failed` | `not_applicable`. `error_code`가 취소·만료를 구분 |
| `unknown` | `unknown` | `unknown`. 자동 재실행하지 않음 |

같은 결과를 재전송할 때는 같은 시도 ID·순번·내용을 사용하고 서버는 `UNIQUE(command_id, attempt_no)`에 해당하는 한 시도로 처리한다. 같은 쌍의 내용이 다르면 서버가 거부한다. `attempt_no`는 서버가 발급하며(대기 명령에 포함) 실제 재실행은 서버가 새 시도로 내린 경우에만 한다. DB의 중복 결과 제약은 OS 중복 실행 방지를 대체하지 않는다. 미보고 상태는 보고 기한·조회 결과에 따라 `unknown`으로 판정하며 단순 통신 실패를 실행 실패로 확정하지 않는다. `unknown`이나 부작용 가능성이 있는 실패는 자동 재실행하지 않는다. ERD의 결과 테이블과 7-2절의 상태 매핑 불일치는 [서버 확인 항목](../delivery/validation.md#서버-erd-반영-후-결정-목록)으로 남긴다.

서버는 결과와 관련 레코드를 커밋한 뒤 저장 확인을 보낸다(최종 ERD 7-8절). 저장 실패나 확인 응답 유실 시 클라이언트는 같은 `command_id`·`attempt_no`의 결과만 재전송하며 OS 명령을 다시 실행하지 않는다. 저장 확인은 결과 보고 완료를 뜻하며 OS 실행 성공과는 별개다. 인증된 동일 사용자·기기·시도에만 보고하며 로그아웃 이후 늦은 보고가 현재 UI나 실행을 되살리지 않는다. 저장 확인은 `POST /commands/{command_id}/results`의 응답(최초 `201`, 같은 결과의 재전송 `200`)이며 같은 쌍에 다른 내용은 `COMMAND_RESULT_CONFLICT`(409), 다른 기기의 명령은 `COMMAND_DEVICE_MISMATCH`(403)다. 재전송 대기열의 영속성·재시도 기한은 구현 이슈에서 정한다. 동의 기반 앱 활동 대기열과 명령 결과 보고를 혼합하지 않는다.

## 음성 데이터 계약

MVP 기본안은 로컬 VAD가 확정한 한 발화를 인증된 HTTPS 요청으로 업로드하는 방식이다. 별도의 음성 변환 API는 없고, 음성은 글과 같은 `POST /conversations/{conversation_id}/messages`에 multipart(`request_id`·`input_method=voice`·`audio`, 선택 `language`)로 제출한다. 서버가 STT → AI 분석 → 명령 생성을 한 요청으로 처리하고 인식 텍스트는 `GET /requests/{request_id}`의 `transcript`로 받는다. 클라이언트의 `RemoteSpeechPort.transcribe`와 `AssistantPort.respond`는 별도 단계로 유지하되 REST 어댑터가 같은 `request_id`로 묶어야 하며, 인식된 텍스트를 응답 요청으로 다시 제출하면 사용자 요청과 명령이 중복되므로 하지 않는다. 응답 음성은 `POST /speech/syntheses`(답변 텍스트·`voice`)로 만들고 받은 오디오(`audio/mpeg` 등)를 재생한다. 글로 입력한 내용은 업로드 없이 텍스트로 제출한다. 오디오 바이트를 JSON 로그나 도구 인자에 넣지 않는다. 실시간 오디오 스트리밍은 MVP 범위 밖이다. 서버의 응답 문장은 실행 전 안내이며 이것만 음성으로 재생하고 실행 결과는 화면에만 표시한다.

| 데이터 | 필수 계약 |
| --- | --- |
| 발화 업로드 | 인증된 사용자·기기(토큰), 경로의 `conversation_id`, `request_id`, 입력 방식, 오디오와 선택 `language`. WAV(PCM 16-bit little-endian·16kHz·모노)만 받으며 헤더로 검증해 맞지 않으면 `422 UNSUPPORTED_AUDIO_FORMAT`이다. 길이는 0.1~20초, 파일은 헤더를 포함해 최대 700,000바이트다. 클라이언트 VAD의 최소 150ms·최대 15초(약 480KB)는 이 범위 안이다. 서버의 현재 한도(10초·320,000바이트)는 올려야 한다(서버 작업) |
| STT 결과 | `GET /requests/{request_id}`의 `transcript`·`processing_status`·`error_code`(`SPEECH_NOT_RECOGNIZED`·`STT_UNAVAILABLE`·`STT_FAILED`). 서버는 빈 결과로 도구를 실행하지 않음 |
| TTS 결과 | 답변 텍스트로 호출해 받는 오디오 형식·길이·바이트 또는 생성 오류(`UPSTREAM_ERROR`, 502). 오디오 오류 시 텍스트 결과 표시. 재생은 실행 전 응답 문장에 한정. 텍스트는 최대 300자(초과 시 `422`)이므로 긴 응답 문장은 음성 단계에서 나누거나 줄이는 정책을 정한다 |
| 취소 | REST 명세에는 음성 업로드·STT·TTS의 취소 API가 없다. 클라이언트가 요청을 중단하고 늦은 결과를 폐기하며 서버 연산의 즉시 중단은 보장하지 않음 |

대기 중 마이크 스트림과 VAD가 완료하지 않은 구간은 전송하지 않는다. 음성 바이트는 오프라인 대기열이나 재연결 자동 재전송 대상에 넣지 않는다. 클라이언트와 서버는 허용 오디오 형식·최대 길이·최대 바이트·요청 기한을 구현 전에 함께 확정한다. 원시 음성의 보관 경계는 [데이터와 보안](data-security.md)을 따른다.

## 명령 전달과 식별자 계약

REST 폴링에서 명령 한 건이 담는 논리 필드는 아래와 같다. wire 필드명은 서버 명세가 원본이다.

| 필드 | 목적 |
| --- | --- |
| `command_id`, `attempt_no` | 명령과 실행 시도의 식별. 로컬 실행 저널·결과 보고·중복 실행 방지의 키 |
| `command_type`, `arguments`, `requested_app_code` | 등록 도구와 검증할 입력. 도구별 인자 스키마는 서버가 정한다 |
| `requested_at` | 기한 판단의 기준. 만료 시각은 없다 |
| 인증된 사용자·기기 | 토큰으로 결정한다. 요청 본문에 `userId`·`deviceId`를 중복 요구하지 않으며 포함된 값은 인증 정보와 대조 |

내부 `executionId`는 `(command_id, attempt_no)`에 안정적으로 대응시키고 재전송 동안 유지한다. 서버에 없는 `capabilityRevision`·도구 버전은 로컬 가용성 검사에만 쓴다. 상위 요청과의 연결은 `GET /requests/{request_id}`의 명령 목록으로 확인한다. 정수 ID는 [REST 전송 계약](#rest-전송-계약)의 규칙으로 받으며 DB `message_id`와 요청 식별자 `request_id`는 다른 것이다.

앱 실행 등 부작용 도구는 `(command_id, attempt_no)` 기준으로 중복 실행을 방지한다. 폴링 전송만으로 exactly-once 실행을 보장한다고 가정하지 않는다. 실행 도중 앱이 종료되거나 연결이 끊겨 결과를 알 수 없으면 `unknown`으로 남기고 자동 재실행하지 않으며, 다음 폴링에서 저널을 먼저 확인한다. 서버는 결과가 보고되기 전까지 같은 명령을 다시 내릴 수 있다.

## 시각 계약

서버 저장 시각은 UTC `DATETIME(6)`이며 API는 UTC임이 명시된 ISO 8601 문자열 등 시간대가 모호하지 않은 형식을 사용한다. 정밀도·직렬화 형식은 wire 스키마에서 확정한다. 화면의 날짜·시각과 기간 조회 경계는 계정의 `USER_SETTINGS.timezone`을 기준으로 변환하고, 종일 일정은 [캘린더](../features/calendar.md)의 날짜 의미를 유지한다. 서버 시각(`requested_at` 등)으로 기한을 판단할 때는 응답으로 알게 된 시계 차이를 보정한다. 실행 기한·지연 측정은 로컬 단조 시계를 사용하며 DB 시각 정밀도를 로컬 타이머에 강제하지 않는다.

## 취소와 오류 규칙

- 실행 대기 중인 요청은 취소·만료 시 시작하지 않는다. 실행 직전에 로컬에서 한 번 더 검사한다.
- 로그아웃·인증 무효화 시 새 도구·음성 요청을 차단하고 현재 인증 세대의 연결·진행 작업을 정리한다. 상세 화면·상태 전이는 [계정 인증](../features/auth.md#인증-상태와-시작-흐름)을 따른다.
- 이미 시작된 OS 동작은 취소가 되돌림을 보장하지 않는다. 실행 여부와 취소 처리 여부를 분리해 안내한다.
- 카메라·마이크·접근성 권한 철회 시 해당 기능을 중단하고 가용 상태를 갱신한다. 마이크 철회·중지 시 SpeechSessionController는 KWS/VAD·음성 업로드·TTS 재생을 중단하고 원시 오디오·대기 발화를 폐기하며 지연된 서버 응답을 거부한다.
- 네트워크 단절·STT 실패 시 완료 발화를 오프라인 대기열에 보관하거나 자동 재전송하지 않는다. TTS 실패 시 확인된 텍스트 결과를 표시한다.
- 로컬 인식이나 네트워크 오류가 있어도 단축키·트레이에서 중지·종료 경로를 사용할 수 있어야 한다. 설정은 인증 정책에 따라 로그인 이후에 제공한다.
- 상태 오버레이가 표시된 순간과 사용자 입력 창을 직접 연 순간을 구분해 포커스 정책을 적용한다.
