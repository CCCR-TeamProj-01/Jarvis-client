# Remote speech

서버 음성 인식의 클라이언트 쪽 포트(`ports.ts`)다. 로컬 VAD가 확정한 완료 발화만 보내고 인식 텍스트를 요청·세션 식별자와 함께 받는다. 응답 생성(`AssistantPort`)은 대화 쪽(`src/main/conversation/ports.ts`)에 있다. 지금은 개발용 대역(`dev-remote-speech.ts`, 두 포트를 모두 구현)과 연결 불가 기본 어댑터만 있다. 실제 HTTP/WSS 엔드포인트와 전송 오디오 형식은 서버 계약이 확정되면 구현하며, 오디오를 오프라인 대기열이나 로그에 저장하지 않는다.
