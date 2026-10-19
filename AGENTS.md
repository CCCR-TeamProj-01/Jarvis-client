# Repository instructions

- 현재 기준 문서는 `docs/README.md`에서 찾는다. `docs/archive/`는 보관본이며 수정 대상이 아니다.
- 기능 변경 시 해당 요구사항 ID와 완료 조건을 유지하거나 함께 갱신한다. 같은 규칙을 여러 문서에 복제하지 않고 원본 문서로 연결한다.
- Electron Main이 실행 상태와 OS 제어 권한을 소유한다. Renderer는 Preload가 노출한 제한된 API만 사용한다. Main은 Renderer와 서버에서 온 입력을 검증한다.
- 음성·영상 원본은 설계 문서의 저장·전송 경계를 따른다. 센서 제어와 로컬 중지 경로는 서버 응답에 의존시키지 않는다.
- 변경 후 가능하면 `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`를 실행한다. 실행하지 못한 검사는 결과에 명시한다.
- 이 저장소는 클라이언트 전용이다. 서버 구현을 이곳에 추가하지 않는다.
- `docs/delivery/feature_list.json`은 검증 가능한 코드·테스트·빌드 설정의 구현 단위를 추적한다. 각 항목은 `id`, `title`, `description`, `status`와 선택적인 `issue`(GitHub 이슈 번호)만 사용한다. `description`은 구현 범위·산출물을 짧게 적고, 상태는 `todo`, `in_progress`, `blocked`, `done` 중 하나로 갱신한다. 같은 구현은 기존 항목을 갱신하고 ID를 재사용하지 않는다. `done`은 코드와 완료 조건을 검증한 경우에만 사용한다.
- 요구사항·완료 조건은 연결된 GitHub 이슈와 원본 명세에서, 검증 결과는 PR과 진행 로그에서 관리한다. 이슈 등록·계획 수립·문서 정리·단순 조회는 새 구현 항목으로 추가하지 않는다.
- 작업을 마치거나 중단·인계할 때 로컬 `.context/PROGRESS.md`에 한 일, 검증 결과, 다음 할 일을 기록한다. 구현 작업이면 기존 F-ID로 연결하고 구현 상태 변경을 `feature_list.json`에 반영한다. 문서·관리 작업은 F-ID 없이 기록한다. 작성 규칙은 파일 상단을 따른다.
- 브랜치, 커밋, PR은 `docs/delivery/git-convention.md`를 따른다.
