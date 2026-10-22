# Remote speech

서버 음성 인식의 클라이언트 쪽 포트(`ports.ts`)다. 로컬 VAD가 확정한 완료 발화만 보내고 인식 텍스트를 요청·세션 식별자와 함께 받는다. 응답 생성(`AssistantPort`)은 대화 쪽(`src/main/conversation/ports.ts`)에 있다. 구현은 세 가지다: 개발용 대역(`dev-remote-speech.ts`, 두 포트를 모두 구현), 서버 어댑터(`server-speech.ts`가 발화를 WAV(`wav.ts`)로 올리고, 응답과 `server-synthesis.ts`의 음성 합성은 `ServerAssistant`가 맡는다. 같은 요청에서 인식과 응답이 이어지기 때문이다), 연결 불가 기본 어댑터. 선택 규칙은 `create-remote-speech.ts`, 동작은 [음성 연동](../../../../docs/architecture/server-integration.md#구현-현황-음성-연동)을 본다. 오디오를 오프라인 대기열이나 로그에 저장하지 않는다.
