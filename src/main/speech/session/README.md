# Speech session

Main이 음성 세션 ID·상태 버전, KWS/VAD 활성화, 완료 발화 전송, 취소·만료, 서버 STT·TTS의 늦은 결과 폐기를 관리한다. TTS 재생 중에는 입력 인식을 억제하고 재생 경계에서 Ring Buffer를 비운다.

현재는 모듈 경계만 정의했다. 상태 전이의 기준은 [음성 명세](../../../../docs/features/speech.md)다.
