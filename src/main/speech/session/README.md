# Speech session

`speech-session.ts`의 `SpeechSessionController`가 음성 대화의 **음성 쪽**을 소유한다: 듣기 시작·종료, 서버 음성 인식 요청, 응답 재생, 시간 제한, 취소, 늦은 결과 폐기. 인식된 글은 대화(`src/main/conversation/`)에 제출하고, 무엇이라고 답할지는 대화가 정한다. 응답 재생 중에는 마이크가 닫혀 있어 입력이 섞이지 않는다. 기준은 [음성 명세](../../../../docs/features/speech.md#대화와-음성-세션의-관계)다. 발화 하나를 받는 `listen()`은 `src/main/speech/voice-input.ts`에 있다.
