# Server connection

Main이 사용자·기기 인증과 서버 연결을 소유한다. 완료 발화의 음성 업로드와 TTS 오디오 수신은 이 연결을 통해 수행하고, 도구 실행 제어 메시지는 WSS 계약을 따른다. Media Renderer에는 인증 자격 증명이나 범용 네트워크·IPC API를 노출하지 않는다.

현재는 모듈 경계만 정의했다. 음성 전송 계약은 [서버 연동 문서](../../../docs/architecture/server-integration.md)를 따른다.
