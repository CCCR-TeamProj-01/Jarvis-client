# 자비스 클라이언트 문서

현재 기준은 2026-10-19 통합 명세 v0.2에서 분리한 뒤 갱신한 아래 문서다. 기능별 요구사항 ID를 유지했다. [통합 원문](archive/jarvis-functional-spec-architecture-v0.2.md)은 이력 보관용이며 현재 설계 변경은 아래 문서에 반영한다.

2026-10-21 서버 ERD 수정 방향과 사용자 이용 흐름을 [#43](https://github.com/CCCR-TeamProj-01/Jarvis-client/issues/43)에서 반영했다. 서버 대화 생성·명령/결과 연결·수집 설정·자체/Google 일정 저장은 목표 명세이며 현재 코드의 구현 완료를 뜻하지 않는다. 미확정 정책은 [서버 ERD 결정 목록](delivery/validation.md#서버-erd-반영-후-결정-목록)에서 관리한다.

| 문서 | 주요 내용과 요구사항 |
| --- | --- |
| [제품 범위](product/scope.md) | MVP·확장 범위, 처리 원칙, BASE·OPS·LIFE |
| [계정 인증](features/auth.md) | AUTH-01~07, 로그인·회원가입·유지·접근 제한·설치 식별과 기기 등록 |
| [호출과 화면](features/interaction-ui.md) | CALL·UI |
| [디자인 시스템](design/design-system.md) | Frosted Pearl, 시각 토큰·컴포넌트·인증 화면·향후 창 레이아웃 |
| [음성과 AI 요청](features/speech.md) | VOICE·AI, 서버 대화 생성·요청 완료와 음성·명령 실행 흐름 |
| [앱과 OS 제어](features/app-control.md) | APP |
| [제스처 제어](features/gesture.md) | GEST |
| [실행 이력과 추천](features/activity-recommendation.md) | HIST·REC, 명령 결과와 활동 분리·수집 동의·추천 승인 |
| [캘린더](features/calendar.md) | CAL, 자체/Google 일정 저장·조회·동기화·연결 해제 |
| [클라이언트 아키텍처](architecture/client.md) | 실행 공간, 모듈, 기술 스택, 독립 상태 |
| [클라이언트 공통 인터페이스](architecture/client-interfaces.md) | 내부 데이터·IPC·모듈 포트·좌표·취소·자원 정리 규약 |
| [서버 연동과 실행 계약](architecture/server-integration.md) | 기기·대화·명령/시도 ID, 결과 보고·시각·오디오·WSS, 취소·만료·중복 실행 |
| [데이터와 보안](architecture/data-security.md) | 저장·삭제·권한·UI 실행 경계 |
| [배포와 검증](delivery/validation.md) | 완료 시나리오, 미확정 항목, 구현 순서, 참고 자료 |
| [구현 현황](delivery/feature_list.json) | 코드 구현 단위의 ID·작업명·짧은 설명·상태·관련 이슈 번호 |
| [Git 컨벤션](delivery/git-convention.md) | 브랜치·커밋·PR 작성 규칙 |

서버 모듈 설명은 클라이언트 연동 계약을 이해하기 위한 내용이다. 서버 구현은 이 저장소의 범위 밖이다.
