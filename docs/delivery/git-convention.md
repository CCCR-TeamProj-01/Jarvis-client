# Git 컨벤션

브랜치, 커밋, PR 작성 규칙이다. 기능 규칙과 요구사항은 [문서 목차](../README.md)의 원본 문서를 따르며 여기에 복제하지 않는다.

## 브랜치

`main`은 항상 `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`를 통과하는 상태로 유지한다. 같은 검사를 `.github/workflows/ci.yml`이 PR마다 실행한다. 작업은 `main`에서 분기한 브랜치에서 하고 PR로 합친다.

형식: `<type>/<요구사항 ID 또는 주제>-<짧은-설명>` (영문 소문자, 하이픈)

예: `feat/call-01-wake-word`, `fix/app-02-window-focus`, `docs/git-convention`

## 커밋

[Conventional Commits](https://www.conventionalcommits.org/ko/v1.0.0/) 형식을 따른다.

```
<type>(<scope>): <요약>

<본문: 무엇을 왜 바꿨는지. 필요할 때만>
```

| type | 용도 |
| --- | --- |
| feat | 기능 추가·변경 |
| fix | 버그 수정 |
| docs | 문서만 변경 |
| refactor | 동작 변경 없는 구조 개선 |
| test | 테스트 추가·수정 |
| build | 빌드·의존성·패키징 설정 |
| chore | 위에 해당하지 않는 잡무 |

- scope는 영역(`main`, `preload`, `renderer`, `speech`, `connection`, `gesture` 등) 또는 요구사항 ID(`CALL-01`)를 쓴다.
- 요약은 한 줄로 쓰고 마침표를 붙이지 않는다. 한국어를 기본으로 하되 팀 안에서 하나로 통일한다.
- 한 커밋에는 한 가지 목적만 담는다. 문서 갱신은 해당 변경과 같은 커밋 또는 같은 PR에 포함한다.
- 호환성을 깨는 변경은 type 뒤에 `!`를 붙이고 본문에 영향을 적는다.

예: `feat(speech): 완료 발화 업로드 클라이언트 추가`, `fix(CALL-01): 호출어 직후 첫 음절이 잘리는 문제 수정`

## Pull Request

- 제목은 커밋 형식을 따른다. 하나의 PR은 하나의 요구사항 또는 주제를 다룬다.
- 본문에 변경 내용, 관련 요구사항 ID와 문서, 실행한 검사 결과를 적는다. 실행하지 못한 검사는 사유를 명시한다.
- 요구사항이나 완료 조건이 바뀌면 원본 문서와 [작업 현황](feature_list.json)을 같은 PR에서 갱신한다.
- 병합 전 CI(`pnpm lint`, `format:check`, `typecheck`, `test`, `build`)가 통과해야 하고 최소 1명의 리뷰를 받는다.
- 병합은 squash를 기본으로 하며 병합 커밋 메시지도 커밋 형식을 지킨다.

## 커밋하지 않는 것

`.env`, 키·인증서 파일, 토큰, 음성·영상 원본과 로컬 모델 파일은 커밋하지 않는다. 저장·전송 경계는 [데이터와 보안](../architecture/data-security.md)을 따른다.
