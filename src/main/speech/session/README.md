# Speech session

`speech-session.ts`의 `SpeechSessionController`가 음성 대화를 소유한다: 세션 ID·상태 버전, 듣기 시작·종료, 서버 요청과 응답 재생, 시간 제한, 취소·만료, 늦은 결과 폐기. 응답 재생 중에는 마이크가 닫혀 있어 입력이 섞이지 않는다. 기준은 [음성 명세](../../../../docs/features/speech.md#구현-현황-음성-세션과-응답-재생)다. 발화 하나를 받는 `listen()`은 `src/main/speech/voice-input.ts`에 있다.
