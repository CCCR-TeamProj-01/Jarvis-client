# Audio capture

Media Renderer가 마이크 PCM·길이 제한 Ring Buffer를 소유한다. 호출 후 로컬 VAD가 완료로 확정한 발화만 제한된 Preload API를 통해 Main에 전달한다. 무음·취소·권한 철회 시 버퍼를 폐기한다.

`ports.ts`에 캡처·버퍼 폐기·구간 추출·PCM 구독 포트를 정의했다. 실제 마이크·Ring Buffer 구현은 후속 작업이다.
