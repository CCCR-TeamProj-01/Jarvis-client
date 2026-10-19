# Repository instructions

- 현재 기준 문서는 `docs/README.md`에서 찾는다. `docs/archive/`는 보관본이며 수정 대상이 아니다.
- 기능 변경 시 해당 요구사항 ID와 완료 조건을 유지하거나 함께 갱신한다. 같은 규칙을 여러 문서에 복제하지 않고 원본 문서로 연결한다.
- Electron Main이 실행 상태와 OS 제어 권한을 소유한다. Renderer는 Preload가 노출한 제한된 API만 사용한다. Main은 Renderer와 서버에서 온 입력을 검증한다.
- 음성·영상 원본은 설계 문서의 저장·전송 경계를 따른다. 센서 제어와 로컬 중지 경로는 서버 응답에 의존시키지 않는다.
- 변경 후 가능하면 `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`를 실행한다. 실행하지 못한 검사는 결과에 명시한다.
- 이 저장소는 클라이언트 전용이다. 서버 구현을 이곳에 추가하지 않는다.
- 작업을 시작·진행·완료할 때마다 `docs/delivery/feature_list.json`에 현재 작업 내용(`current_work`), 현황(`status`), 설명(`description`)을 갱신한다. 작성 규칙은 파일의 `_guide`를 따른다.
- 작업을 마치거나 중단·인계할 때 로컬 `.context/PROGRESS.md`에 한 일, 검증 결과, 다음 할 일을 기록하고 상태 변경은 `feature_list.json`에도 반영한다. 작성 규칙은 파일 상단을 따른다.
- 브랜치, 커밋, PR은 `docs/delivery/git-convention.md`를 따른다.
