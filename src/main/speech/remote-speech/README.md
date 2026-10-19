# Remote speech

Main의 인증된 연결을 통해 로컬 VAD가 확정한 발화만 서버 STT에 보낸다. 서버 STT 텍스트와 서버 TTS 오디오를 요청·음성 세션 ID에 연결하고, 취소·기한·상태 버전을 검사한다. 오디오를 오프라인 대기열이나 로그에 저장하지 않는다.

HTTP/WSS의 실제 엔드포인트와 오디오 형식은 서버 계약이 확정되면 구현한다. 현재 공유 타입은 `src/shared/speech-protocol/`에 있다.
